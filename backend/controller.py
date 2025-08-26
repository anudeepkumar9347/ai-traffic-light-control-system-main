import asyncio
import time
from dataclasses import dataclass, field
from typing import Dict, Literal, Optional
import logging

PhaseGroup = Literal["NS", "EW"]
Stage = Literal["GREEN", "YELLOW", "ALL_RED"]


@dataclass
class ControllerConfig:
    min_green: float = 10.0
    max_green: float = 120.0
    yellow: float = 3.0
    all_red: float = 2.0
    gap_seconds: float = 2.0
    queue_clear: bool = True
    priority_switch: bool = True
    priority_factor: float = 2.0  # switch if opp >= factor * current
    priority_min_queue: int = 6   # and opp at least this many
    all_red_hold_max: float = 5.0 # max extra wait in ALL_RED for clearance


@dataclass
class ControllerState:
    phase: PhaseGroup = "NS"
    stage: Stage = "GREEN"
    last_change: float = field(default_factory=time.time)
    queues: Dict[str, int] = field(default_factory=lambda: {"north": 0, "south": 0, "east": 0, "west": 0})
    last_arrival: Dict[PhaseGroup, float] = field(default_factory=lambda: {"NS": 0.0, "EW": 0.0})
    switches: int = 0
    throughput: int = 0
    waiting_total: int = 0
    occupancy: int = 0
    pending_phase: Optional[PhaseGroup] = None


class ActuatedController:
    def __init__(self, cfg: ControllerConfig):
        self.cfg = cfg
        self.state = ControllerState()
        now = time.time()
        self.state.last_arrival = {"NS": now, "EW": now}
        self._lock = asyncio.Lock()
        self._log = logging.getLogger("controller")

    async def request_phase_preference(self, phase: PhaseGroup):
        """Set a preferred phase to switch to when safe (after min green and when current queue is 0)."""
        async with self._lock:
            self.state.pending_phase = phase
            self._log.info(f"Phase preference requested: {phase}")

    def _current_lights(self) -> Dict[str, str]:
        if self.state.stage == "GREEN":
            vertical = "green" if self.state.phase == "NS" else "red"
            horizontal = "green" if self.state.phase == "EW" else "red"
        elif self.state.stage == "YELLOW":
            # Yellow on outgoing direction only
            vertical = "yellow" if self.state.phase == "NS" else "red"
            horizontal = "yellow" if self.state.phase == "EW" else "red"
        else:
            vertical = horizontal = "red"
        return {"vertical": vertical, "horizontal": horizontal}

    async def update_sensor(self, data: Dict):
        async with self._lock:
            now = time.time()
            # Support two formats:
            # 1) direct counts: {north:int, south:int, east:int, west:int}
            # 2) incremental: {arrivals:{...}, departures:{...}}
            if any(k in data for k in ("arrivals", "departures")):
                arrivals = data.get("arrivals", {}) or {}
                departures = data.get("departures", {}) or {}
                for d in ("north", "south", "east", "west"):
                    a = int(arrivals.get(d, 0) or 0)
                    b = int(departures.get(d, 0) or 0)
                    if a:
                        # Update last arrival for the corresponding phase group
                        grp = "NS" if d in ("north", "south") else "EW"
                        self.state.last_arrival[grp] = now
                    # Adjust queue conservatively (never below 0)
                    self.state.queues[d] = max(0, int(self.state.queues.get(d, 0)) + a - b)
                    if b:
                        self.state.throughput += b
            else:
                counts = {k: int(v) for k, v in data.items() if k in ("north", "south", "east", "west")}
                if counts:
                    self.state.queues.update({k: max(0, int(v)) for k, v in counts.items()})
                    if counts.get("north", 0) > 0 or counts.get("south", 0) > 0:
                        self.state.last_arrival["NS"] = now
                    if counts.get("east", 0) > 0 or counts.get("west", 0) > 0:
                        self.state.last_arrival["EW"] = now
            if "occupancy" in data:
                try:
                    self.state.occupancy = max(0, int(data.get("occupancy", 0) or 0))
                except Exception:
                    pass

    async def tick(self):
        async with self._lock:
            now = time.time()
            t_in_stage = now - self.state.last_change
            if self.state.stage == "GREEN":
                # Decide whether to stay or start change
                if t_in_stage < self.cfg.min_green:
                    return
                cur = self.state.phase
                opp = "EW" if cur == "NS" else "NS"
                cur_sum = (self.state.queues["north"] + self.state.queues["south"]) if cur == "NS" else (self.state.queues["east"] + self.state.queues["west"])
                opp_sum = (self.state.queues["east"] + self.state.queues["west"]) if opp == "EW" else (self.state.queues["north"] + self.state.queues["south"])
                time_since_last_arrival_cur = now - self.state.last_arrival[cur]

                # Queue-clearing takes precedence: if serving cars, keep green until cleared or max_green
                if self.cfg.queue_clear and cur_sum > 0 and t_in_stage < self.cfg.max_green:
                    self._log.debug(f"Hold green for {cur}: queue_clear active cur_sum={cur_sum} t={t_in_stage:.1f}")
                    return

                # Failsafe max green
                if t_in_stage >= self.cfg.max_green:
                    self._log.info(f"Max green reached for {cur} at {t_in_stage:.1f}s; switching")
                    self.state.stage = "YELLOW"
                    self.state.last_change = now
                    return

                # Priority preemption only if current queue is empty (or queue_clear disabled)
                if self.cfg.priority_switch and (not self.cfg.queue_clear or cur_sum == 0) and t_in_stage >= self.cfg.min_green:
                    if opp_sum >= max(self.cfg.priority_min_queue, int(self.cfg.priority_factor * max(1, cur_sum))):
                        self._log.info(f"Priority switch: cur={cur} cur_sum={cur_sum} opp_sum={opp_sum} t={t_in_stage:.1f}")
                        self.state.stage = "YELLOW"
                        self.state.last_change = now
                        return
                # Otherwise, consider switching only if opposing demand exists
                if opp_sum > 0:
                    if self.cfg.queue_clear:
                        # Switch when current cleared
                        if cur_sum == 0:
                            self._log.info(f"Current queue cleared for {cur}; switching to {opp}")
                            self.state.stage = "YELLOW"
                            self.state.last_change = now
                            return
                    else:
                        # Classic gap-out
                        if time_since_last_arrival_cur >= self.cfg.gap_seconds:
                            self._log.info(f"Gap-out switch: no arrivals on {cur} for {time_since_last_arrival_cur:.1f}s; opp has demand {opp_sum}")
                            self.state.stage = "YELLOW"
                            self.state.last_change = now
                            return
            elif self.state.stage == "YELLOW":
                if t_in_stage >= self.cfg.yellow:
                    self.state.stage = "ALL_RED"
                    self.state.last_change = now
                    return
            elif self.state.stage == "ALL_RED":
                # Wait for minimum all_red and until intersection occupancy clears, with a maximum extension
                if t_in_stage >= self.cfg.all_red:
                    if self.state.occupancy > 0 and t_in_stage < (self.cfg.all_red + self.cfg.all_red_hold_max):
                        # keep waiting for clearance
                        return
                    # Grant green to preferred phase if set, else toggle
                    if self.state.pending_phase and self.state.pending_phase in ("NS", "EW"):
                        self.state.phase = self.state.pending_phase
                        self.state.pending_phase = None
                    else:
                        self.state.phase = "EW" if self.state.phase == "NS" else "NS"
                    self.state.stage = "GREEN"
                    self.state.last_change = now
                    self.state.switches += 1
                    return

    def snapshot(self) -> Dict:
        now = time.time()
        t_in_stage = now - self.state.last_change
        lights = self._current_lights()
        # Approximate next change time
        if self.state.stage == "GREEN":
            # min of remaining min green, possible gap or max
            # We don’t know the future arrivals; expose remaining to max as an upper bound
            time_to_next = max(0, int(self.cfg.max_green - t_in_stage))
        elif self.state.stage == "YELLOW":
            time_to_next = max(0, int(self.cfg.yellow - t_in_stage))
        else:
            time_to_next = max(0, int(self.cfg.all_red - t_in_stage))

        waiting = sum(self.state.queues.values())
        self.state.waiting_total = waiting

        return {
            "phase": self.state.phase,
            "stage": self.state.stage,
            "time_in_stage": round(t_in_stage, 2),
            "time_to_next_change": time_to_next,
            "lights": lights,
            "queues": self.state.queues,
            "occupancy": self.state.occupancy,
            "switches": self.state.switches,
            "throughput": self.state.throughput,
            "waiting": waiting,
            "config": {
                "min_green": self.cfg.min_green,
                "max_green": self.cfg.max_green,
                "yellow": self.cfg.yellow,
                "all_red": self.cfg.all_red,
                "gap_seconds": self.cfg.gap_seconds,
            },
            "t": int(now * 1000),
        }
