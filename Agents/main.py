# Main Module
from Agents.state_manager import TravelState
from Agents.agents import (FlightAgent,RailAgent,ValidatorAgent)
import json

def run_swarm():
    state = TravelState(user_prompt = "I want to fly from Kolkata to Delhi, and then take a train to Agra.",max_budget=0.0)
    flight_agent = FlightAgent("flightspec")
    rail_agent = RailAgent("railspec")
    validator_agent = ValidatorAgent("validspec")
    print("=== LIVE LLM MULTI-MODAL SWARM RUNNING ===\n")
    for iteration in range (1,4):
        print(f"\n--- Swarm Loop: Cycle {iteration} ---")
        flight_agent.run(state)
        rail_agent.run(state)
        validator_agent.run(state)
        if state.is_validated:
            print("\nSWARM AGREEMENT ACHIEVED")
            break
        else:
            print(f"\n[System Loop Event]: Correction triggered. Error context distributed back to swarm.")
            
            # Self-Healing Feedback Loop: 
            # If the timeline failed, wipe out the rail leg and let the agent re-try on next pass
            if any("Temporal Breach" in error for error in state.validation_errors):
                print("[System Override]: Pruning problematic Rail leg to allow rescheduling...")
                state.current_itinerary = [leg for leg in state.current_itinerary if leg.type != "rail"]
                # Give the prompt a hint so the LLM knows it messed up
                state.user_prompt += " (Note: Make sure the train departure leaves significantly later than the flight landing.)"

    print("\n=============================================")
    if state.is_validated:
        print("SWARM AGREEMENT ACHIEVED")
    else:
        print("⚠ SWARM FAILED TO PRODUCE A VALID ITINERARY AFTER 3 CYCLES")
        print("Remaining issues:")
        for err in state.validation_errors:
            print(f"  - {err}")
    print("\nFINAL COMPILED ITINERARY (status reflects last attempt, not necessarily valid):")
    for leg in state.current_itinerary:
        print(
            f" - [{leg.type.upper()}] {leg.operator} {leg.identification_number} | "
            f"{leg.from_location} -> {leg.to_location} | "
            f"Dep: {leg.departure_time} | Cost: ${leg.cost} | Status: {leg.status}"
        )
    print("=============================================")
if __name__ == "__main__":
    run_swarm()