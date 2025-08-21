import os
import json
import logging

import numpy as np
import pandas as pd

# --- Paths ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
Q_TABLE_FILE = os.path.join(BASE_DIR, "q_table.json")
TRAFFIC_LOG_FILE = os.path.join(BASE_DIR, "traffic_log.csv")

# --- Logging ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Q-learning Params ---
ALPHA = 0.1
GAMMA = 0.9
EPSILON = 0.1
WAITING_BINS = [0, 5, 15, 30, 50, np.inf]
ACTIONS = [0, 1]

Q_table = {}

def get_state_bin(waiting_cars):
    return int(np.digitize(waiting_cars, WAITING_BINS) - 1)

def get_state(vertical_waiting, horizontal_waiting, current_green_direction):
    v_bin = get_state_bin(vertical_waiting)
    h_bin = get_state_bin(horizontal_waiting)
    return (v_bin, h_bin, current_green_direction)

def initialize_q_state(state):
    if state not in Q_table:
        Q_table[state] = {action: 0.0 for action in ACTIONS}

# Load existing Q-table if any
if os.path.exists(Q_TABLE_FILE):
    try:
        with open(Q_TABLE_FILE, "r") as f:
            loaded_q_table = json.load(f)
            Q_table = {eval(k): v for k, v in loaded_q_table.items()}
        logging.info(f"Loaded existing Q-table from {Q_TABLE_FILE}")
    except (json.JSONDecodeError, SyntaxError) as e:
        logging.error(f"Error loading Q-table from {Q_TABLE_FILE}: {e}. Starting fresh.")


def train_q_agent(log_file):
    logging.info(f"Starting training from {log_file}")
    try:
        df = pd.read_csv(log_file)
    except FileNotFoundError:
        logging.error(f"Log file not found: {log_file}")
        return
    except pd.errors.EmptyDataError:
        logging.warning(f"Log file is empty: {log_file}")
        return

    for i in range(len(df) - 1):
        row = df.iloc[i]
        next_row = df.iloc[i + 1]
        vertical_waiting = row['vertical_waiting']
        horizontal_waiting = row['horizontal_waiting']
        current_green_direction = 0 if row['current_vertical_light'] == "green" else 1
        state = get_state(vertical_waiting, horizontal_waiting, current_green_direction)
        initialize_q_state(state)
        action_taken = 1 if row['action_taken'] == "switch" else 0
        reward = row['reward']
        next_vertical_waiting = next_row['vertical_waiting']
        next_horizontal_waiting = next_row['horizontal_waiting']
        next_current_green_direction = 0 if next_row['current_vertical_light'] == "green" else 1
        next_state = get_state(next_vertical_waiting, next_horizontal_waiting, next_current_green_direction)
        initialize_q_state(next_state)
        old_q = Q_table[state][action_taken]
        max_next_q = max(Q_table[next_state].values())
        Q_table[state][action_taken] = old_q + ALPHA * (reward + GAMMA * max_next_q - old_q)

    try:
        with open(Q_TABLE_FILE, "w") as f:
            json.dump({str(k): v for k, v in Q_table.items()}, f, indent=4)
        logging.info(f"Saved trained Q-table to {Q_TABLE_FILE}")
    except IOError as e:
        logging.error(f"Error saving Q-table: {e}")


if __name__ == "__main__":
    train_q_agent(TRAFFIC_LOG_FILE)
