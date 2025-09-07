import numpy as np
from traffic_model import TrafficModel
import time

SIDE_NAMES = ['North', 'East', 'South', 'West']

class SimulationHandler:
    def __init__(self):
        self.traffic_model = TrafficModel()
        self.last_optimization = 0
        self.performance_history = []
        
        # Traffic engineering constants
        self.INTERGREEN_TIME = 3.0  # All-red clearance time
        self.MINIMUM_GREEN = 5.0
        self.MAXIMUM_GREEN = 45.0
        self.CYCLE_TIME_RANGE = (60, 150)

    def simulate_congestion(self, congestion_data):
        """
        Advanced traffic signal optimization using AI and traffic engineering principles.
        Returns an optimized schedule considering:
        - Traffic demand patterns
        - Signal timing constraints
        - Pedestrian safety requirements
        - System efficiency metrics
        """
        # Normalize and validate input
        if congestion_data is None:
            congestion = np.array([0.0, 0.0, 0.0, 0.0])
        else:
            # Handle nested lists and ensure proper format
            cong = []
            for c in congestion_data:
                if isinstance(c, (list, tuple, np.ndarray)) and len(c) > 0:
                    cong.append(float(c[0]))
                else:
                    cong.append(float(c))
            
            congestion = np.array(cong, dtype=float)
            if congestion.size != 4:
                congestion = np.resize(congestion, 4)

        # Calculate traffic metrics
        total_demand = congestion.sum()
        max_demand = congestion.max()
        demand_variance = np.var(congestion) if total_demand > 0 else 0
        
        # Determine cycle time based on traffic intensity
        if total_demand <= 10:
            base_cycle = 60  # Light traffic
        elif total_demand <= 40:
            base_cycle = 80  # Medium traffic
        elif total_demand <= 80:
            base_cycle = 100  # Heavy traffic
        else:
            base_cycle = 120  # Very heavy traffic
            
        # Adjust for demand imbalance
        imbalance_factor = 1 + (demand_variance / (total_demand + 1)) * 0.2
        cycle_time = min(150, base_cycle * imbalance_factor)
        
        # Calculate green time allocation
        total_green = cycle_time - (4 * self.INTERGREEN_TIME)  # Account for all phases
        
        if total_demand <= 0:
            # Equal time for no traffic scenario
            green_times = np.array([total_green / 4.0] * 4)
        else:
            # Use AI model if trained, otherwise use advanced heuristics
            if self.traffic_model.trained:
                green_times = []
                for demand in congestion:
                    pred = self.traffic_model.predict(np.array([[demand]]))
                    green_times.append(pred[0])
                green_times = np.array(green_times)
            else:
                # Advanced proportional allocation with saturation and efficiency considerations
                proportions = congestion / (total_demand + 1e-9)
                
                # Apply saturation flow adjustments
                saturation_factor = 1 - np.exp(-total_demand / 50)  # Diminishing returns
                adjusted_proportions = proportions * (0.7 + 0.3 * saturation_factor)
                
                green_times = adjusted_proportions * total_green
            
            # Apply engineering constraints
            green_times = np.clip(green_times, self.MINIMUM_GREEN, self.MAXIMUM_GREEN)
            
            # Ensure total doesn't exceed available time
            if green_times.sum() > total_green:
                green_times = green_times * (total_green / green_times.sum())

        # Create optimized schedule with priority ordering
        schedule = self._create_optimized_schedule(congestion, green_times, cycle_time)
        
        # Update performance tracking
        self._track_performance(congestion, schedule)
        
        result = {
            'cycle_time': round(cycle_time, 2),
            'green_total': round(green_times.sum(), 2),
            'schedule': schedule,
            'optimization_timestamp': time.time(),
            'demand_metrics': {
                'total_demand': round(total_demand, 1),
                'max_demand': round(max_demand, 1),
                'imbalance': round(demand_variance, 2)
            }
        }
        
        return result
    
    def _create_optimized_schedule(self, congestion, green_times, cycle_time):
        """Create schedule with intelligent phase ordering"""
        # Calculate priority scores considering multiple factors
        priority_scores = []
        for i, (demand, green_time) in enumerate(zip(congestion, green_times)):
            # Priority based on: demand level, efficiency ratio, and delay potential
            efficiency = green_time / (demand + 1) if demand > 0 else 1
            delay_potential = demand * demand  # Quadratic delay growth
            priority = demand + (delay_potential / 100) - (efficiency * 2)
            priority_scores.append((priority, i))
        
        # Sort by priority (highest first)
        priority_scores.sort(reverse=True)
        
        schedule = []
        cumulative_time = 0
        
        for priority, idx in priority_scores:
            side = SIDE_NAMES[idx]
            green_duration = float(round(green_times[idx], 2))
            
            schedule.append({
                'side': side,
                'green_duration': green_duration,
                'start_after': float(round(cumulative_time, 2)),
                'priority_score': round(priority, 2),
                'demand_level': round(congestion[idx], 1)
            })
            
            cumulative_time += green_duration + self.INTERGREEN_TIME
        
        return schedule
    
    def _track_performance(self, congestion, schedule):
        """Track system performance for continuous improvement"""
        performance_metric = {
            'timestamp': time.time(),
            'total_demand': congestion.sum(),
            'cycle_efficiency': sum(item['green_duration'] for item in schedule) / 
                              sum(item['green_duration'] + self.INTERGREEN_TIME for item in schedule),
            'load_balance': 1 - (np.var(congestion) / (np.mean(congestion) + 1e-9))
        }
        
        self.performance_history.append(performance_metric)
        
        # Keep only recent history (last 100 cycles)
        if len(self.performance_history) > 100:
            self.performance_history = self.performance_history[-100:]

# Example usage with enhanced testing
if __name__ == "__main__":
    handler = SimulationHandler()
    
    # Test various traffic scenarios
    test_scenarios = [
        [[5], [10], [3], [7]],      # Light traffic
        [[15], [25], [12], [20]],   # Medium traffic  
        [[30], [45], [25], [35]],   # Heavy traffic
        [[50], [10], [45], [15]],   # Imbalanced traffic
        [[0], [0], [0], [0]]        # No traffic
    ]
    
    for i, scenario in enumerate(test_scenarios):
        print(f"\n--- Scenario {i+1}: {[s[0] for s in scenario]} ---")
        result = handler.simulate_congestion(scenario)
        print(f"Cycle time: {result['cycle_time']}s")
        print(f"Demand metrics: {result['demand_metrics']}")
        for item in result['schedule']:
            print(f"  {item['side']}: {item['green_duration']}s (priority: {item['priority_score']})")
