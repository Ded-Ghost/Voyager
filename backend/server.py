from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Agents.state_manager import TravelState
from Agents.agents import (
    FlightAgent,
    RailAgent,
    ValidatorAgent
)
app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "Travel Agent Swarm Online"}

@app.post("/run-swarm")
def run_swarm_endpoint(data: dict):
    user_prompt = data.get(
        "user_prompt",
        ""
    )
    state = TravelState(
        user_prompt=user_prompt,
        max_budget=0.0
    )
    flight_agent = FlightAgent("flightspec")
    rail_agent = RailAgent("railspec")
    validator_agent = ValidatorAgent("validspec")

    for _ in range(3):

        flight_agent.run(state)
        rail_agent.run(state)
        validator_agent.run(state)
        if state.is_validated:
            break
        if any(
            "Temporal Breach" in err
            for err in state.validation_errors
        ):
            state.current_itinerary = [
                leg
                for leg in state.current_itinerary
                if leg.type != "rail"
            ]

            state.user_prompt += (
                " Train departure must be "
                "at least 2 hours after "
                "flight arrival."
            )
    print("\n===== API RESPONSE =====")
    print(state.model_dump())
    return state.model_dump()