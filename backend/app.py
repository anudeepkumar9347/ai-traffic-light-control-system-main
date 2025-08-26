import os
import json
import logging
import time
import threading
import csv
from typing import Dict, Optional

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# --- Paths ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
STATE_FILE = os.path.join(BASE_DIR, "traffic_state.json")
TRAFFIC_LOG_FILE = os.path.join(BASE_DIR, "traffic_log.csv")
Q_TABLE_FILE = os.path.join(BASE_DIR, "q_table.json")

# --- Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Q-learning Setup ---
Q_table: Dict = {}
ALPHA = 0.1
GAMMA = 0.9
EPSILON = 0.1
WAITING_BINS = [0, 5, 15, 30, 50, np.inf]
ACTIONS = [0, 1]  # 0 = stay, 1 = switch

def get_state_bin(waiting_cars):
    return int(np.digitize(waiting_cars, WAITING_BINS) - 1)

def get_discrete_state(vertical_waiting, horizontal_waiting, current_green_direction):
    v_bin = get_state_bin(vertical_waiting)
    h_bin = get_state_bin(horizontal_waiting)
    return (v_bin, h_bin, current_green_direction)

def initialize_q_state(state):
    if state not in Q_table:
        Q_table[state] = {action: 0.0 for action in ACTIONS}

# Load Q-table if exists
if os.path.exists(Q_TABLE_FILE):
    try:
        with open(Q_TABLE_FILE, "r") as f:
            loaded_q_table = json.load(f)
            Q_table = {eval(k): v for k, v in loaded_q_table.items()}
        logging.info(f"Loaded Q-table from {Q_TABLE_FILE}")
    except (json.JSONDecodeError, SyntaxError) as e:
        logging.error(f"Error loading Q-table from {Q_TABLE_FILE}: {e}. Starting with empty Q-table.")

# --- FastAPI ---
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class TrafficInput(BaseModel):
    north: int
    south: int
    east: int
    west: int

class SensorInput(BaseModel):
    north: Optional[int] = None
    south: Optional[int] = None
    east: Optional[int] = None
    west: Optional[int] = None
    arrivals: Optional[Dict[str, int]] = None
    departures: Optional[Dict[str, int]] = None
    occupancy: Optional[int] = None

# --- Config ---
def load_config():
    try:
        with open(CONFIG_FILE, "r") as f:
            return json.load(f)
    except FileNotFoundError:
        logging.warning("config.json not found, using default values.")
        return {"MIN_GREEN_TIME": 15, "YELLOW_TIME": 3}
    except json.JSONDecodeError:
        logging.error("Error decoding config.json, using default values.")
        return {"MIN_GREEN_TIME": 15, "YELLOW_TIME": 3}

config = load_config()
MIN_GREEN_TIME = config.get("MIN_GREEN_TIME", 15)
YELLOW_TIME = config.get("YELLOW_TIME", 3)
# Add a realistic all-red clearance interval between phase changes
ALL_RED_TIME = config.get("ALL_RED_TIME", 2)

# --- Persistent State ---
def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r") as f:
                return json.load(f)
        except json.JSONDecodeError:
            logging.error(f"Error reading {STATE_FILE}. Starting with a fresh state.")
            return {}
    return {
        "main": {
            "lights": {"vertical": "green", "horizontal": "red"},
            "waiting_cars": {"north": 0, "south": 0, "east": 0, "west": 0},
            "last_change_time": time.time(),
            "is_changing": False,
        }
    }

def save_state(state):
    try:
        with open(STATE_FILE, "w") as f:
            json.dump(state, f, indent=4)
    except IOError as e:
        logging.error(f"Could not save state to {STATE_FILE}: {e}")

state = load_state()

# --- New: Actuated controller with WS broadcast ---
try:
    from controller import ActuatedController, ControllerConfig
except Exception:
    ActuatedController = None  # type: ignore

controller = None
clients = set()

async def controller_loop():
    global controller
    if ActuatedController is None:
        return
    cfg = ControllerConfig(
        min_green=MIN_GREEN_TIME,
        max_green=max(MIN_GREEN_TIME + 30, 120),
        yellow=YELLOW_TIME,
        all_red=ALL_RED_TIME,
        gap_seconds=2.0,
        queue_clear=True,
    )
    controller = ActuatedController(cfg)
    # Prime queues from state if present
    try:
        await controller.update_sensor(state.get("main", {}).get("waiting_cars", {}))
    except Exception:
        pass
    while True:
        try:
            await controller.tick()
            snap = controller.snapshot()
            # broadcast to WS clients
            if clients:
                dead = []
                for ws in list(clients):
                    try:
                        await ws.send_json({"type": "state", "data": snap})
                    except Exception:
                        dead.append(ws)
                for d in dead:
                    clients.discard(d)
        except Exception:
            pass
        await asyncio.sleep(0.1)

# --- Logging traffic data for training ---
def log_traffic_data(intersection_id, vertical_waiting, horizontal_waiting, current_vertical_light, current_horizontal_light, action_taken, reward):
    file_exists = os.path.isfile(TRAFFIC_LOG_FILE)
    with open(TRAFFIC_LOG_FILE, 'a', newline='') as csvfile:
        fieldnames = ['timestamp', 'intersection_id', 'vertical_waiting', 'horizontal_waiting', 'current_vertical_light', 'current_horizontal_light', 'action_taken', 'reward']
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        if not file_exists:
            writer.writeheader()
        writer.writerow({
            'timestamp': time.time(),
            'intersection_id': intersection_id,
            'vertical_waiting': vertical_waiting,
            'horizontal_waiting': horizontal_waiting,
            'current_vertical_light': current_vertical_light,
            'current_horizontal_light': current_horizontal_light,
            'action_taken': action_taken,
            'reward': reward,
        })

# --- API ---
@app.post("/traffic")
async def update_traffic(data: TrafficInput, intersection: str = "main"):
    if intersection not in state:
        state[intersection] = {
            "lights": {"vertical": "green", "horizontal": "red"},
            "waiting_cars": {"north": 0, "south": 0, "east": 0, "west": 0},
            "last_change_time": time.time(),
            "is_changing": False,
        }
    state[intersection]["waiting_cars"] = data.dict()
    # Legacy logic retained; new controller will consider these queues too
    if not controller:
        # Only use legacy logic if new controller is not active
        run_ai_logic(intersection)
    # Also feed the actuated controller immediately and set phase preference by bigger queue
    try:
        if controller:
            ns_total = int(data.north) + int(data.south)
            ew_total = int(data.east) + int(data.west)
            preferred = "NS" if ns_total >= ew_total else "EW"
            await controller.update_sensor(data.dict())
            # Request preferred phase; controller will honor it when safe (after clearance)
            try:
                await controller.request_phase_preference(preferred)  # type: ignore[attr-defined]
            except Exception:
                pass
    except Exception:
        pass
    save_state(state)
    return {"message": f"Traffic data updated for {intersection}"}

@app.post("/sensor")
async def sensor(data: SensorInput):
    """Live sensor/arrival or queue counts from the frontend to feed the controller."""
    if controller:
        await controller.update_sensor(data.dict())
    return {"ok": True}

@app.get("/state")
def get_state_api(intersection: str = "main"):
    # Prefer the new controller snapshot if available
    if controller:
        return controller.snapshot()
    if intersection not in state:
        return {"error": "Intersection not found"}
    s = state[intersection]
    now = time.time()
    time_since_last_change = now - s.get("last_change_time", now)
    time_to_next_change = 0
    if not s.get("is_changing", False):
        time_to_next_change = MIN_GREEN_TIME - time_since_last_change
    return {
        "lights": s["lights"],
        "time_to_next_change": max(0, int(time_to_next_change)),
    }

# --- Simple health and help endpoints ---
@app.get("/health")
def health():
    """Health check endpoint."""
    return {"status": "ok"}

@app.get("/help")
def api_help():
    """Describe how to use the API."""
    return {
        "title": "AI Traffic Light Control System API",
        "endpoints": {
            "POST /traffic": {
                "query": "?intersection=main",
                "body": {"north": "int", "south": "int", "east": "int", "west": "int"},
                "desc": "Send current vehicle counts; triggers decision logic.",
            },
            "GET /state": {
                "query": "?intersection=main",
                "desc": "Get current lights and seconds until next change.",
            },
            "POST /reset": {
                "query": "?intersection=main",
                "desc": "Reset an intersection to defaults.",
            },
            "GET /health": {"desc": "Service status."},
        },
    }

@app.post("/reset")
def reset_intersection(intersection: str = "main"):
    """Reset an intersection to default state."""
    state[intersection] = {
        "lights": {"vertical": "green", "horizontal": "red"},
        "waiting_cars": {"north": 0, "south": 0, "east": 0, "west": 0},
        "last_change_time": time.time(),
        "is_changing": False,
    }
    save_state(state)
    return {"message": f"Reset {intersection}"}

# --- AI Logic ---
def run_ai_logic(intersection: str = "main"):
    s = state[intersection]
    if s["is_changing"]:
        return
    now = time.time()
    time_since_last_change = now - s["last_change_time"]
    vertical_waiting = s["waiting_cars"]["north"] + s["waiting_cars"]["south"]
    horizontal_waiting = s["waiting_cars"]["east"] + s["waiting_cars"]["west"]
    current_vertical_light = s["lights"]["vertical"]
    current_horizontal_light = s["lights"]["horizontal"]
    current_green_direction = 0 if current_vertical_light == "green" else 1

    current_state = get_discrete_state(vertical_waiting, horizontal_waiting, current_green_direction)
    initialize_q_state(current_state)

    # Choose best known action
    action_to_take = int(np.argmax([Q_table[current_state][a] for a in ACTIONS]))
    action_name = "stay"
    reward = 0

    if time_since_last_change < MIN_GREEN_TIME:
        action_to_take = 0
        action_name = "stay"
        reward = 0
    elif action_to_take == 1:
        start_light_change(intersection)
        action_name = "switch"
        reward = -(vertical_waiting + horizontal_waiting)

    log_traffic_data(
        intersection,
        vertical_waiting,
        horizontal_waiting,
        current_vertical_light,
        current_horizontal_light,
        action_name,
        reward,
    )


def start_light_change(intersection: str = "main"):
    # Legacy function; ignore if new controller is active
    if controller:
        return
    s = state[intersection]
    if s["is_changing"]:
        return

    def change_sequence():
        s["is_changing"] = True
        if s["lights"]["vertical"] == "green":
            s["lights"]["vertical"] = "yellow"
            changing_direction = "vertical"
        else:
            s["lights"]["horizontal"] = "yellow"
            changing_direction = "horizontal"
        save_state(state)
        time.sleep(YELLOW_TIME)
        # All-red clearance: both directions red briefly to clear the intersection
        s["lights"]["vertical"] = "red"
        s["lights"]["horizontal"] = "red"
        save_state(state)
        time.sleep(ALL_RED_TIME)
        # Switch the right movement to green after clearance
        if changing_direction == "vertical":
            s["lights"]["horizontal"] = "green"
        else:
            s["lights"]["vertical"] = "green"
        s["last_change_time"] = time.time()
        s["is_changing"] = False
        save_state(state)

    threading.Thread(target=change_sequence, daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    import asyncio as _asyncio
    # Kick off controller loop in background when running directly
    try:
        loop = _asyncio.get_event_loop()
        loop.create_task(controller_loop())
    except RuntimeError:
        pass
    uvicorn.run(app, host="0.0.0.0", port=8000)

# ASGI startup event for controller when run under uvicorn/gunicorn
import asyncio
from contextlib import suppress

@app.on_event("startup")
async def _start_controller():
    with suppress(Exception):
        asyncio.create_task(controller_loop())

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        # On connect, send a first snapshot if available
        if controller:
            await websocket.send_json({"type": "state", "data": controller.snapshot()})
        while True:
            # Optionally receive messages from client; ignore for now
            msg = await websocket.receive_text()
            # In future we could handle sensor updates via WS
            _ = msg
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
