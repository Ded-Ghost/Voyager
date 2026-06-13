# Agents Module
import os
from dotenv import load_dotenv
from Agents.state_manager import (TravelState, ItineraryLeg, DestinationSuggestion)
import pandas as pd
from typing import List
import requests
from Agents.llm_provider import ask_llm
import json

load_dotenv()

def normalize_date(date_str: str) -> str:
    """Convert common date formats to YYYY-MM-DD. Falls back to original if unrecognized."""
    from datetime import datetime as _dt
    date_str = (date_str or "").strip()
    for fmt in ("%Y-%m-%d", "%d.%m.%Y", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return _dt.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return date_str  # last resort — will likely fail isoformat parse below

def normalize_leg(data: dict) -> dict:
    # type normalization
    if data.get("type") == "train":
        data["type"] = "rail"
    # mode normalization
    if data.get("mode") == "rail":
        data["mode"] = "train"
    # status normalization
    if data.get("status") == "booked":
        data["status"] = "confirmed"
    if data.get("status") == "scheduled":
        data["status"] = "proposed"
    return data

def clean_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```json"):
        text = text.replace("```json", "", 1)
    if text.startswith("```"):
        text = text.replace("```", "", 1)
    if text.endswith("```"):
        text = text[:-3]
    text = text.strip()

    if text.startswith("{"):
        depth = 0
        for i, char in enumerate(text):
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[:i+1]
    elif text.startswith("["):
        depth = 0
        for i, char in enumerate(text):
            if char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
                if depth == 0:
                    return text[:i+1]
    return text

class TravelData:
    _token = None
    _schedules_df = None
    _stations_df = None
    _dataset_initialized = False

    @classmethod
    def _init_kaggle_dataset(cls):
        """
        Natively registers and indexes the downloaded Kaggle Indian Railways Dataframes.
        """
        if cls._dataset_initialized:
            return

        try:
            # Adjust file paths if your Kaggle dataset is located inside a nested folder
            schedules_path = "schedules.csv"
            stations_path = "stations.csv"

            if os.path.exists(schedules_path) and os.path.exists(stations_path):
                cls._schedules_df = pd.read_csv(schedules_path)
                cls._stations_df = pd.read_csv(stations_path)
                cls._dataset_initialized = True
                print("[Kaggle Registry]: Indian Railways dataset parsed successfully.")
            else:
                print("[Kaggle Registry Warning]: CSV files not detected in root directory. Using dynamic fallback arrays.")
        except Exception as e:
            print(f"[Kaggle Registry Error]: Failed to initialize tables: {str(e)}")

    @staticmethod
    def _get_iata_code(city_name: str) -> str:
        """
        Helper to convert city names to IATA codes.
        CHANGE HERE: Replace with a real airport-lookup API call, 
        or maintain a local dict for common Indian cities as a quick fix.
        """
        IATA_MAP = {
            "agra": "AGR",
            "ahmedabad": "AMD",
            "agartala": "IXA",
            "amritsar": "ATQ",
            "bagdogra": "IXB",
            "bangalore": "BLR",
            "bhopal": "BHO",
            "bhubaneswar": "BBI",
            "chandigarh": "IXC",
            "chennai": "MAA",
            "cochin": "COK",
            "coimbatore": "CJB",
            "dehradun": "DED",
            "delhi": "DEL",
            "goa": "GOI",
            "guwahati": "GAU",
            "gwalior": "GWL",
            "hyderabad": "HYD",
            "indore": "IDR",
            "jaipur": "JAI",
            "jammu": "IXJ",
            "jodhpur": "JDH",
            "kanpur": "KNU",
            "khajuraho": "HJR",
            "kolkata": "CCU",
            "kozhikode": "CCJ",
            "leh": "IXL",
            "lucknow": "LKO",
            "madurai": "IXM",
            "manali": "KUU",
            "mangalore": "IXE",
            "mopa": "GOX",
            "mumbai": "BOM",
            "nagpur": "NAG",
            "pantnagar": "PGH",
            "patna": "PAT",
            "pune": "PNQ",
            "raipur": "RPR",
            "rajkot": "RAJ",
            "ranchi": "IXR",
            "shirdi": "SAG",
            "silchar": "IXS",
            "srinagar": "SXR",
            "surat": "STV",
            "tirupati": "TIR",
            "tiruchirappalli": "TRZ",
            "trivandrum": "TRV",
            "udaipur": "UDR",
            "vadodara": "BDQ",
            "varanasi": "VNS",
            "vijayawada": "VGA",
            "visakhapatnam": "VTZ"
        }

        return IATA_MAP.get(city_name.strip().lower(), city_name[:3].upper())
    
    @staticmethod
    def _get_station_code(city_name: str) -> str:
        STATION_MAP = {
                "agartala": "AGTL",
                "agra": "AGC",
                "ahmedabad": "ADI",
                "ajmer": "AII",
                "allahabad": "PRYJ",
                "amritsar": "ASR",
                "asansol": "ASN",
                "aurangabad": "AWB",
                "bagdogra": "SGUJ",
                "bangalore": "SBC",
                "bareilly": "BE",
                "bhopal": "BPL",
                "bhubaneswar": "BBS",
                "bikaner": "BKN",
                "bilaspur": "BSP",
                "chandigarh": "CDG",
                "chennai": "MAS",
                "cochin": "ERS",
                "coimbatore": "CBE",
                "cuttack": "CTC",
                "darjeeling": "DJ",
                "dehradun": "DDN",
                "delhi": "NDLS",
                "dhanbad": "DHN",
                "dibrugarh": "DBRG",
                "durgapur": "DGR",
                "gaya": "GAYA",
                "goa": "MAO",
                "gorakhpur": "GKP",
                "guwahati": "GHY",
                "gwalior": "GWL",
                "haridwar": "HW",
                "howrah": "HWH",
                "hyderabad": "HYB",
                "indore": "INDB",
                "jabalpur": "JBP",
                "jaipur": "JP",
                "jalandhar": "JUC",
                "jammu": "JAT",
                "jamshedpur": "TATA",
                "jhansi": "VGLJ",
                "jodhpur": "JU",
                "kanpur": "CNB",
                "kharagpur": "KGP",
                "kozhikode": "CLT",
                "kolkata": "HWH",
                "kota": "KOTA",
                "lucknow": "LKO",
                "ludhiana": "LDH",
                "madurai": "MDU",
                "mangalore": "MAJN",
                "mathura": "MTJ",
                "meerut": "MTC",
                "mumbai": "CSTM",
                "muzaffarpur": "MFP",
                "mysore": "MYS",
                "nagpur": "NGP",
                "nashik": "NK",
                "patna": "PNBE",
                "puducherry": "PDY",
                "pune": "PUNE",
                "puri": "PURI",
                "raipur": "R",
                "rajkot": "RJT",
                "ranchi": "RNC",
                "rameswaram": "RMM",
                "secunderabad": "SC",
                "shirdi": "SNSI",
                "shimla": "SML",
                "siliguri": "SGUJ",
                "surat": "ST",
                "thrissur": "TCR",
                "tirupati": "TPTY",
                "tiruchirappalli": "TPJ",
                "trivandrum": "TVC",
                "udaipur": "UDZ",
                "ujjain": "UJN",
                "vadodara": "BRC",
                "varanasi": "BSB",
                "vijayawada": "BZA",
                "visakhapatnam": "VSKP"
            }
        return STATION_MAP.get(city_name.strip().lower(), city_name[:3].upper())

    
    @classmethod
    def get_live_flight(cls, from_location: str, to_location: str, departure_date: str = None):
        """
        Integration layer for Aviationstack API.
        Requires AVIATIONSTACK_API_KEY in your .env file.
        """
        api_key = os.getenv("AVIATIONSTACK_API_KEY")
        if not api_key:
            print("[Aviationstack Alert]: Missing API key, deploying mock fallback.")
            return {"real_operator": "Air India", "real_identification_no": "AI803"}
        url = "https://api.aviationstack.com/v1/flights"
        dep_iata = cls._get_iata_code(from_location)
        arr_iata = cls._get_iata_code(to_location)
        params = {
            "access_key": api_key,
            "dep_iata": dep_iata,
            "arr_iata": arr_iata,
            "limit": 1
        }
        try:
            response = requests.get(url, params=params, timeout=15)
            if response.status_code == 200:
                data = response.json()
                flight_data = data.get("data", [])
                if flight_data:
                    first_flight = flight_data[0]
                    airline = first_flight.get("airline", {}).get("name", "Domestic Carrier")
                    flight_num = first_flight.get("flight", {}).get("iata", "6E-Air")
                    return {
                        "real_operator": airline,
                        "real_identification_no": flight_num
                    }
        except Exception as e:
            print(f"[Aviationstack Exception]: {str(e)}")
        return {"real_operator": "6E (IndiGo)", "real_identification_no": "6E2134"}
    
    @classmethod
    def get_live_rail(cls, from_location: str, to_location: str, departure_date: str = None):
        cls._init_kaggle_dataset()
        
        from_code = cls._get_station_code(from_location)
        to_code = cls._get_station_code(to_location)

        # Query Kaggle tables directly if loaded in memory
        if cls._dataset_initialized and cls._schedules_df is not None:
            try:
                # Find trains serving the origin station code
                origin_trains = cls._schedules_df[cls._schedules_df['station_code'] == from_code]
                # Find trains serving the destination station code
                dest_trains = cls._schedules_df[cls._schedules_df['station_code'] == to_code]
                
                # Perform an inner intersection join on matching train numbers
                matching_routes = pd.merge(origin_trains, dest_trains, on='train_number', suffixes=('_src', '_dst'))
                
                # Filter routes running in the correct direction (source sequence comes before destination sequence)
                # Kaggle datasets track sequence ordering via the chronological ID or day column layout
                valid_direction = matching_routes[matching_routes['id_src'] < matching_routes['id_dst']]
                
                if not valid_direction.empty:
                    first_match = valid_direction.iloc[0]
                    return {
                        "real_operator": f"Indian Railways ({first_match['train_name_src']})",
                        "real_identification_no": str(int(first_match['train_number']))
                    }
            except Exception as e:
                print(f"[Kaggle Query Error]: Table scan execution failed: {str(e)}")

        # Clean fallback routing engine if direct matrix match isn't found 
        return {
            "real_operator": f"Indian Railways (Express via {from_code})",
            "real_identification_no": "12626"
        }

class BaseAgent:
    def __init__(self, name:str):
        self.name = name
    def log(self,state: TravelState,message:str):
        log_entry = f"[{self.name}]:{message}"
        print(log_entry)
        state.agent_logs.append(log_entry)

class DestinationSuggesterAgent(BaseAgent):

    def run(self, user_prompt: str) -> List[DestinationSuggestion]:

        prompt = f"""
        You are a Destination Curator for travelers in India.
        Based on the user's interests, suggest exactly 4 destinations.
        User Request:
        {user_prompt}
        Return ONLY valid JSON.
        Example:
        [
          {{
            "destination": "Jaipur",
            "reason": "Historic forts and rich culture.",
            "best_for": "culture"
          }},
          {{
            "destination": "Manali",
            "reason": "Excellent trekking and mountain scenery.",
            "best_for": "adventure"
          }}
        ]
        Rules:
        - Return exactly 5 destinations
        - No markdown
        - No explanation
        - JSON array only.Output must be parseable by Python json.loads().
        """
        try:
            response = ask_llm(prompt)
            suggestions_data = json.loads(
                clean_json(response)
            )
            return [
                DestinationSuggestion(**item)
                for item in suggestions_data
            ]
        except Exception as e:
            print(
                f"[DestinationSuggesterAgent] Error: {str(e)}"
            )
            return []
    

class FlightAgent(BaseAgent):
    def run(self,state: TravelState):
        self.log(state,"Analyzing travel guide according to user...")
        if any(leg.type=="flight" for leg in state.current_itinerary):
            self.log(state, "Flight leg already present. Skipping.")
            return
        intent_check = ask_llm(f"""Analyze this travel request:{state.user_prompt}Does this request require a FLIGHT/AIR leg? Reply with exactly one word: YES or NO.""").strip().upper()
        if not intent_check.startswith("YES"):
            self.log(state, "Flight routing not required for this itinerary. Stepping aside.")
            return
        try:
            response = ask_llm(f"""
            Generate a valid flight itinerary.
            User Request:
            {state.user_prompt}
            Return ONLY ONE valid JSON object — do not repeat, duplicate, or output multiple JSON blocks.
            Example format:
            {{
            "type":"flight",
            "mode":"air",
            "operator":" ",
            "identification_number":" ",
            "flight_name":" ",
            "from_location":" ",
            "to_location":" ",
            "departure_date":" ",
            "departure_time":" ",
            "arrival_date":" ",
            "arrival_time":" ",
            "cost": ,
            "status":" "
            }}
            Output EXACTLY ONE JSON object. No markdown. No explanation. No trailing text after the closing brace. Output must be parseable by Python json.loads().""")
            print("\nRAW FLIGHT RESPONSE:")
            print(repr(response))
            flight_data = json.loads(clean_json(response))
            if "itinerary" in flight_data:
                flight_json = next((leg for leg in flight_data["itinerary"] if leg.get("type") == "flight"), None)
            elif "legs" in flight_data:
                flight_json = next((leg for leg in flight_data["legs"] if leg.get("type") == "flight"), None)
            elif flight_data.get("type") == "flight":
                flight_json = flight_data
            else:
                flight_json = None
            if flight_json is None:
                self.log(state, "LLM did not return a valid flight leg. Skipping flight.")
                return
            #flight_json = next(leg for leg in flight_data["itinerary"] if leg["type"] == "flight")
            flight_json = normalize_leg(flight_json)
            if flight_json.get("status") not in ("proposed", "confirmed"):
                flight_json["status"] = "proposed"
            print("\nPARSED FLIGHT DATA:")
            print(flight_data)

            flight_leg = ItineraryLeg(leg_index=len(state.current_itinerary),**flight_json)

            # Overwrite operator/identification_number with live Aviationstack data
            api_data = TravelData.get_live_flight(flight_leg.from_location, flight_leg.to_location)
            flight_leg.operator = api_data["real_operator"]
            flight_leg.identification_number = api_data["real_identification_no"]

            state.current_itinerary.append(flight_leg)
            self.log(state, f"Proposed Flight: {flight_leg.from_location} -> {flight_leg.to_location}")
        except Exception as e:
            self.log(state, f"Error generating flight: {str(e)}")

class RailAgent(BaseAgent):
    def run(self,state:TravelState):
        self.log(state, "Evaluating contextual rail options via LLM...")
        if any(leg.type=="rail" for leg in state.current_itinerary):
            self.log(state,"Rail leg already exists.")
            return
        intent_check = ask_llm(f"""Determine if rail transport is required.User request:{state.user_prompt}Reply only with YES or NO.""").strip().upper()
        if intent_check == "NO":
            self.log(
                state,
                "Rail leg not required for this itinerary. Stepping aside."
            )
            return
        system_prompt = (
            "You are a Rail Network Specialist. Review the user request and any current itinerary context. "
            "Your job is to add a valid train leg to help the user reach their destination. "
            "If a flight leg is present, connect the train from the airport arrival city. "
            "If NO flight leg is present, build the entire journey using trains from the starting location. "
            "Set type to 'rail' and mode to 'train'. status must be 'proposed'."
            "Provide a realistic rail operator name as 'operator' (e.g., 'Indian Railways'), "
            "a train number as 'identification_number' (e.g., '12626'), "
            "and the full train name as 'train_name' (e.g., 'Howrah Rajdhani Express'). "
            "IMPORTANT: departure_date and arrival_date must be in 'YYYY-MM-DD' format. "
            "departure_time and arrival_time must be in 'HH:MM:SS' format (24-hour, no date or timezone). "
            "Provide a realistic rail operator name (e.g., Eurostar) and a train identification_number or service identifier (e.g., ES9044)."
        )
        current_itinerary_context = str([leg.model_dump() for leg in state.current_itinerary])
        try:
            response = ask_llm(f"""
            Generate a valid rail itinerary.
            User Request:
            {state.user_prompt}
            Return ONLY valid JSON.
            Example format:
            {{
            "type":" ",
            "mode":" ",
            "operator":" ",
            "identification_number":" ",
            "train_name":" ",
            "from_location":" ",
            "to_location":" ",
            "departure_date":" ",
            "departure_time":" ",
            "arrival_date":" ",
            "arrival_time":" ",
            "cost": ,
            "status":" "
            }}No markdown.No explanation.JSON only.Do not wrap in ```json.Do not explain.Output must be parseable by Python json.loads().""")
            rail_data = json.loads(clean_json(response))
            if "itinerary" in rail_data:
                rail_json = next(leg for leg in rail_data["itinerary"] if leg["type"] in ["train", "rail"])
            elif "legs" in rail_data:
                rail_json = next(leg for leg in rail_data["legs"] if leg["type"] == "rail")
            elif rail_data.get("type") == "flight":
                rail_json = rail_data
            else:
                rail_json = rail_data
            #rail_json = next(leg for leg in rail_data["itinerary"] if leg["type"] in ["train", "rail"])
            rail_json = normalize_leg(rail_json)
            if rail_json.get("status") not in ("proposed", "confirmed"):
                rail_json["status"] = "proposed"
            if rail_json.get("mode") not in ("air", "train"):
                rail_json["mode"] = "train"
            print("\nRAW RAIL RESPONSE:")
            print(response)
            print("\nPARSED RAIL DATA:")
            print(rail_data)
            rail_leg = ItineraryLeg(leg_index=len(state.current_itinerary),**rail_json)
            if rail_leg.from_location and rail_leg.to_location:
                api_data = TravelData.get_live_rail(rail_leg.from_location, rail_leg.to_location)
                rail_leg.operator = api_data["real_operator"]
                rail_leg.identification_number = api_data["real_identification_no"]
                rail_leg.leg_index = len(state.current_itinerary)
                state.current_itinerary.append(rail_leg)
                self.log(state, f"Proposed Rail: {rail_leg.from_location} -> {rail_leg.to_location}")
        except Exception as e:
            self.log(state, f"Error generating rail: {str(e)}")

class ValidatorAgent(BaseAgent):
    def run(self,state:TravelState):
        self.log(state, "Executing cross-modal timeline validation...")
        state.validation_errors = []
        state.is_validated = False
        if not state.current_itinerary:
            state.validation_errors.append("No itinerary generated.")
        flight = next((leg for leg in state.current_itinerary if leg.type=="flight"),None)
        rail = next((leg for leg in state.current_itinerary if leg.type=="rail"),None)
        if flight and rail:
            from datetime import datetime
            f_arr_date = normalize_date(flight.arrival_date)
            r_dep_date = normalize_date(rail.departure_date)
            f_arr = datetime.fromisoformat(f"{f_arr_date}T{flight.arrival_time}")
            r_dep = datetime.fromisoformat(f"{r_dep_date}T{rail.departure_time}")
            time_difference = (r_dep - f_arr).total_seconds() / 60
            if time_difference < 120: # Requires a minimum 2-hour transfer window
                state.validation_errors.append(f"Temporal Breach: Layover is only {time_difference} mins. Need 120+ mins for safe customs extraction.")
            CITY_ALIASES = {
                "kolkata": "kolkata",
                "howrah": "kolkata",
                "new delhi": "delhi",
                "delhi": "delhi"
            }

            flight_dest = CITY_ALIASES.get(
                flight.to_location.lower(),
                flight.to_location.lower()
            )

            rail_origin = CITY_ALIASES.get(
                rail.from_location.lower(),
                rail.from_location.lower()
            )
            if flight_dest != rail_origin:
                state.validation_errors.append("Route Breach: Rail journey does not begin where flight ends.")
        if flight and not rail:
            state.validation_errors.append("Incomplete itinerary: missing required rail segment.")
        if rail and not flight:
            state.validation_errors.append("Incomplete itinerary: missing required flight segment.")
        if not flight and not rail:
            state.validation_errors.append("No itinerary generated.")
        if not state.validation_errors:
            state.is_validated = True
            for leg in state.current_itinerary:
                leg.status = "confirmed"
            self.log(state, "Cleared. Itinerary meets all financial and structural constraints.")
        else:
            state.is_validated = False
            self.log(state, f"Validation Rejection: {state.validation_errors}")