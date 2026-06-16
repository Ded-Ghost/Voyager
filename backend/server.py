from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from Agents.state_manager import TravelState
from Agents.agents import (
    FlightAgent,
    RailAgent,
    ValidatorAgent,
    parse_legs,
)
app = FastAPI()
origins = [
    "http://localhost:7777",
    "https://voyager-qpn7.onrender.com"  # Add your live frontend link here!
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "Travel Agent Swarm Online"}

@app.post("/run-swarm")
def run_swarm_endpoint(data: dict):
    user_prompt = data.get("user_prompt", "")
    state = TravelState(user_prompt=user_prompt, max_budget=0.0)
    flight_agent = FlightAgent("flightspec")
    rail_agent = RailAgent("railspec")
    validator_agent = ValidatorAgent("validspec")

    # 1. Parse the trip into ordered legs up front. "Kolkata to Delhi then
    #    Bangalore" -> two legs (CCU->DEL, DEL->BLR). "Delhi to Mumbai" -> one
    #    leg. Each leg carries its own mode hint, preference, date, and time window.
    legs = parse_legs(user_prompt)
    print(f"\n[Swarm] Parsed {len(legs)} leg(s): "
          + " | ".join(
              f"{l['from']}->{l['to']} [{l['mode_hint']}/{l['prefer']}"
              + (f" @{l['date']}" if l.get('date') else "")
              + (f" after {l['depart_after']}" if l.get('depart_after') else "")
              + (f" before {l['depart_before']}" if l.get('depart_before') else "")
              + "]"
              for l in legs))

    def _route_one_leg(leg):
        """Route a single parsed leg, honouring its mode hint, preference and time
        window. For mode_hint 'any' we try flight first (Indians favour air for
        intercity hops); if no flight leg was added, fall back to rail. We do NOT
        force both modes — a flight-only or rail-only trip is perfectly valid."""
        mh = leg["mode_hint"]
        common = dict(prefer=leg["prefer"], date=leg.get("date", ""),
                      depart_after=leg.get("depart_after", ""),
                      depart_before=leg.get("depart_before", ""))
        if mh == "flight":
            flight_agent.run_leg(state, leg["from"], leg["to"], **common)
        elif mh == "rail":
            rail_agent.run_leg(state, leg["from"], leg["to"], **common)
        else:
            before = len(state.current_itinerary)
            flight_agent.run_leg(state, leg["from"], leg["to"], **common)
            if len(state.current_itinerary) == before:
                rail_agent.run_leg(state, leg["from"], leg["to"], **common)

    if legs:
        # Works for BOTH single-hop and multi-stop: route each leg, then validate
        # the assembled itinerary once. The validator no longer demands both a
        # flight and a rail leg, so single-mode trips validate correctly.
        for leg in legs:
            _route_one_leg(leg)
        validator_agent.run(state)
    else:
        # Unparseable prompt — fall back to the legacy 3-cycle exploratory flow.
        for _ in range(3):
            flight_agent.run(state)
            rail_agent.run(state)
            validator_agent.run(state)
            if state.is_validated:
                break
            if any("Temporal Breach" in err for err in state.validation_errors):
                state.current_itinerary = [
                    leg for leg in state.current_itinerary if leg.type != "rail"
                ]
                state.user_prompt += (
                    " Train departure must be at least 2 hours after flight arrival."
                )

    print("\n===== API RESPONSE =====")
    print(state.model_dump())
    return state.model_dump()