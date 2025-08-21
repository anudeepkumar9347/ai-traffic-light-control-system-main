AI Traffic Control System

Project structure
- frontend/: Static web UI (p5.js simulation)
  - index.html, style.css, sketch.js, trafficData.json
- backend/: FastAPI service and training utilities
  - app.py, requirements.txt, config.json, traffic_state.json, train_q_agent.py, q_table.json (generated), traffic_log.csv (generated)

How to run
1) Backend
   - cd backend
   - Create a venv (optional) and install deps: pip install -r requirements.txt
   - Start API: uvicorn app:app --reload --port 8000
2) Frontend
   - cd frontend
   - Serve statically (e.g., python -m http.server 5500) and open http://127.0.0.1:5500
   - The frontend calls the backend at http://127.0.0.1:8000

Notes
- Original top-level files remain; use the versions inside frontend/ and backend/ going forward.
- Training: backend/train_q_agent.py reads backend/traffic_log.csv and writes backend/q_table.json.
