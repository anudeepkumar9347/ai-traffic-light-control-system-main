import os
import json
import logging
import time
import threading
import csv
from typing import Dict

import numpy as np
from fastapi import FastAPI
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
def update_traffic(data: TrafficInput, intersection: str = "main"):
    if intersection not in state:
        state[intersection] = {
            "lights": {"vertical": "green", "horizontal": "red"},
            "waiting_cars": {"north": 0, "south": 0, "east": 0, "west": 0},
            "last_change_time": time.time(),
            "is_changing": False,
        }
    state[intersection]["waiting_cars"] = data.dict()
    run_ai_logic(intersection)
    save_state(state)
    return {"message": f"Traffic data updated for {intersection}"}

@app.get("/state")
def get_state_api(intersection: str = "main"):
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
        if changing_direction == "vertical":
            s["lights"]["vertical"] = "red"
            s["lights"]["horizontal"] = "green"
        else:
            s["lights"]["horizontal"] = "red"
            s["lights"]["vertical"] = "green"
        s["last_change_time"] = time.time()
        s["is_changing"] = False
        save_state(state)

    threading.Thread(target=change_sequence, daemon=True).start()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
