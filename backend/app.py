from flask import Flask, request, jsonify
from flask_cors import CORS
from traffic_model import TrafficModel
from simulation_handler import SimulationHandler
import numpy as np
import os

# Serve the frontend folder as static
app = Flask(__name__, static_folder=os.path.join(os.path.dirname(__file__), '..', 'frontend'), static_url_path='')
CORS(app)  # Enable CORS for all routes

traffic_model = TrafficModel()
simulation_handler = SimulationHandler()

# Cache for reducing unnecessary computations
last_congestion_data = None
last_schedule = None

@app.route('/')
def index():
    # Serve the frontend index.html
    return app.send_static_file('index.html')

@app.route('/train', methods=['POST'])
def train_model():
    data = request.json
    X = np.array(data['X'])
    y = np.array(data['y'])
    traffic_model.train(X, y)
    # update the model inside simulation handler as well
    simulation_handler.traffic_model = traffic_model
    return jsonify({"message": "Model trained successfully"})

@app.route('/predict', methods=['POST'])
def predict_traffic():
    data = request.json
    X = np.array(data['X'])
    prediction = traffic_model.predict(X)
    return jsonify({"prediction": prediction.tolist()})

@app.route('/simulate', methods=['POST'])
def simulate_congestion():
    global last_congestion_data, last_schedule
    # Basic input validation
    if not request.is_json:
        return jsonify({"error": "Expected JSON body"}), 400
    data = request.get_json(silent=True) or {}
    congestion_data = data.get('congestion_data')
    if congestion_data is None or not isinstance(congestion_data, (list, tuple)):
        return jsonify({"error": "congestion_data must be a list"}), 400
    # Flatten and coerce to numbers
    try:
        flat = [ (c[0] if isinstance(c, (list, tuple)) else c) for c in congestion_data ]
        if len(flat) != 4:
            return jsonify({"error": "congestion_data must contain 4 entries (N,E,S,W)"}), 400
        flat = [ float(x) for x in flat ]
        # Clamp to reasonable bounds
        flat = [ max(0.0, min(10000.0, x)) for x in flat ]
        # Rebuild structure for downstream code compatibility
        congestion_data = [[x] for x in flat]
    except Exception:
        return jsonify({"error": "invalid congestion_data values"}), 400
    
    # Check if congestion data has significantly changed
    if last_congestion_data is not None:
        if congestion_data is not None:
            # Only recalculate if changes are significant (>20% change or difference > 2)
            old_sum = sum(last_congestion_data) if last_congestion_data else 0
            new_sum = sum([c[0] if isinstance(c, list) else c for c in congestion_data]) if congestion_data else 0
            
            if abs(new_sum - old_sum) < max(2, 0.2 * old_sum) and last_schedule is not None:
                return jsonify(last_schedule)
    
    # Calculate new schedule
    adjustments = simulation_handler.simulate_congestion(congestion_data)
    # Invariant checks (non-invasive): ensure sane schedule
    try:
        schedule = adjustments.get('schedule', [])
        seen = set()
        clean = []
        for item in schedule:
            side = item.get('side')
            g = float(item.get('green_duration', 0))
            if side in seen:
                continue  # enforce unique sides
            seen.add(side)
            # clamp green duration between 0 and 120 defensively (final rendering also clamps)
            item['green_duration'] = max(0.0, min(120.0, g))
            clean.append(item)
        adjustments['schedule'] = clean
    except Exception:
        # If anything odd happens, keep original adjustments to avoid changing logic
        pass
    
    # Update cache
    last_congestion_data = [c[0] if isinstance(c, list) else c for c in congestion_data] if congestion_data else [0, 0, 0, 0]
    last_schedule = adjustments
    
    return jsonify(adjustments)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok"}), 200

if __name__ == '__main__':
    app.run(debug=True)
