# State Manager Module
from pydantic import BaseModel, Field
from typing import List, Optional, Union,Literal

class ItineraryLeg(BaseModel):
    leg_index: int
    type: Literal["flight","rail"]
    mode: Literal["air","train"]
    operator: str
    identification_number: Union[str, int]
    train_name: Optional[str] = None
    flight_name: Optional[str] = None
    from_location: str
    to_location: str
    departure_date: str
    departure_time: str
    arrival_date: str
    arrival_time: str
    cost: float
    status: Literal["proposed","confirmed"]
    notes: Optional[str] = None

class DestinationSuggestion(BaseModel):
    destination:str
    reason:str
    best_for:str

class DestinationSuggestionList(BaseModel):
    suggestions: List[DestinationSuggestion]

class TravelState(BaseModel):
    user_prompt: str
    max_budget: float
    current_itinerary: List[ItineraryLeg] = Field(default_factory=list)
    agent_logs: List[str] = Field(default_factory=list)
    is_validated: bool = False
    validation_errors: List[str] = Field(default_factory=list)