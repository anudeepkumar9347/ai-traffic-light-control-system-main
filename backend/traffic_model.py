import numpy as np
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
import warnings
warnings.filterwarnings('ignore')

class TrafficModel:
    def __init__(self):
        # Use ensemble of models for better prediction
        self.linear_model = LinearRegression()
        self.rf_model = RandomForestRegressor(n_estimators=10, random_state=42, max_depth=5)
        self.trained = False
        
        # Pre-trained patterns based on traffic engineering principles
        self.base_patterns = {
            'low_traffic': {'cycle': 60, 'min_green': 8, 'max_green': 15},
            'medium_traffic': {'cycle': 80, 'min_green': 12, 'max_green': 25},
            'high_traffic': {'cycle': 120, 'min_green': 15, 'max_green': 35}
        }

    def train(self, X, y):
        """Train both models with traffic data"""
        try:
            X = np.array(X).reshape(-1, 1) if X.ndim == 1 else X
            y = np.array(y)
            
            if len(X) > 5:  # Need minimum data for RF
                self.rf_model.fit(X, y)
            self.linear_model.fit(X, y)
            self.trained = True
        except Exception as e:
            print(f"Training error: {e}")
            self.trained = False

    def predict(self, X):
        """Predict optimal light duration using ensemble method"""
        try:
            X = np.array(X).reshape(-1, 1) if X.ndim == 1 else X
            
            if not self.trained:
                # Use heuristic based on traffic density
                traffic_level = X[0][0] if X.ndim > 1 else X[0]
                return np.array([self._heuristic_prediction(traffic_level)])
            
            # Ensemble prediction
            linear_pred = self.linear_model.predict(X)
            
            try:
                rf_pred = self.rf_model.predict(X)
                # Weight predictions: 70% RF, 30% linear for stability
                prediction = 0.7 * rf_pred + 0.3 * linear_pred
            except:
                prediction = linear_pred
                
            return np.clip(prediction, 5, 45)  # Reasonable bounds
            
        except Exception as e:
            print(f"Prediction error: {e}")
            traffic_level = X[0][0] if hasattr(X, '__len__') and len(X) > 0 else 10
            return np.array([self._heuristic_prediction(traffic_level)])
    
    def _heuristic_prediction(self, traffic_level):
        """Intelligent heuristic for traffic light timing"""
        if traffic_level <= 5:
            return 8  # Minimum green for low traffic
        elif traffic_level <= 15:
            return 8 + (traffic_level - 5) * 0.8  # Gradual increase
        elif traffic_level <= 30:
            return 16 + (traffic_level - 15) * 0.6  # Medium increase
        else:
            return min(35, 25 + (traffic_level - 30) * 0.3)  # Cap at 35s

# Example usage with enhanced data
if __name__ == "__main__":
    # Simulated training data with more realistic patterns
    X_train = np.array([[5], [10], [15], [20], [25], [30], [35], [40], [45]])
    y_train = np.array([8, 12, 16, 20, 25, 28, 32, 35, 38])  # Optimal durations

    traffic_model = TrafficModel()
    traffic_model.train(X_train, y_train)

    # Test predictions
    test_cases = [[8], [18], [32], [50]]
    for case in test_cases:
        prediction = traffic_model.predict(np.array(case))
        print(f"Traffic density: {case[0]}, Predicted duration: {prediction[0]:.1f}s")
