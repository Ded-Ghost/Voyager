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

def parse_time(time_str: str):
    """Parse a time string into (hour, minute), tolerating HH:MM, HH:MM:SS,
    and 12-hour forms like '6:00 PM' / '6 pm'. Returns None if unparseable."""
    from datetime import datetime as _dt
    s = (time_str or "").strip().upper().replace(".", "")
    if not s:
        return None
    for fmt in ("%H:%M:%S", "%H:%M", "%I:%M %p", "%I %p", "%I:%M%p", "%I%p"):
        try:
            t = _dt.strptime(s, fmt)
            return (t.hour, t.minute)
        except ValueError:
            continue
    return None

def parse_dt(date_str: str, time_str: str):
    """Combine a date and time into a datetime, robust to messy formats.
    Returns None if either piece can't be parsed."""
    from datetime import datetime as _dt
    d = normalize_date(date_str)
    hm = parse_time(time_str)
    if not d or hm is None:
        return None
    try:
        base = _dt.strptime(d, "%Y-%m-%d")
        return base.replace(hour=hm[0], minute=hm[1])
    except ValueError:
        return None
    
def _build_time_hint(date: str = "", depart_after: str = "", depart_before: str = "") -> str:
    """Build a natural-language constraint line for the agent prompt from the
    parsed per-leg date / time-window hints. Returns '' when nothing is set."""
    parts = []
    if date:
        parts.append(f"The journey date is {date} (use this exact departure_date).")
    if depart_after and depart_before:
        parts.append(f"Departure time must be between {depart_after} and {depart_before}.")
    elif depart_after:
        parts.append(f"Departure time must be at or after {depart_after}.")
    elif depart_before:
        parts.append(f"Departure time must be at or before {depart_before}.")
    return ("Time constraints: " + " ".join(parts)) if parts else ""

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
    # cost normalization — the LLM often returns "₹4,500", "4500 INR", "Rs. 4500"
    # or even an empty string. TravelLeg.cost is a float, so a stray string would
    # make validation fail and the ENTIRE leg would be silently dropped (which
    # looked like "first leg missing" and "no price"). Coerce to a clean number.
    raw_cost = data.get("cost", None)
    if isinstance(raw_cost, str):
        # Strip thousands separators, then grab the first real number (handles
        # "₹4,500", "Rs. 5200", "4500 INR", "1,25,000", "4500.00").
        m = re.search(r"\d+(?:\.\d+)?", raw_cost.replace(",", ""))
        try:
            data["cost"] = float(m.group()) if m else 0.0
        except ValueError:
            data["cost"] = 0.0
    elif raw_cost is None:
        data["cost"] = 0.0
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

def parse_legs(user_prompt: str) -> list:
    """Extract the ordered list of journey legs from a user prompt.

    Returns a list of dicts:
      [{"from": str, "to": str,
        "mode_hint": "flight"|"rail"|"any",
        "prefer": "cheap"|"fast"|"best",
        "date": str|"",          # YYYY-MM-DD if the user gave one, else ""
        "depart_after": str|"",  # HH:MM (24h) lower bound, else ""
        "depart_before": str|""  # HH:MM (24h) upper bound, else ""
      }]

    Multi-stop trips like "Kolkata to Delhi then Bangalore then Hyderabad" become
    three legs (CCU->DEL, DEL->BLR, BLR->HYD). "Break/stopover/halt at M" splits
    into two legs. Single trips return one leg.

    Also extracts per-leg time windows so requests like "flight to Mumbai after
    6pm" or "morning train to Agra" produce grounded departure times.

    This runs ONE small LLM call up front; the heavy flight/rail agents then run
    per-leg, so they each get a clean single-hop request to reason about.
    """
    prompt = f"""You are a journey parser. Read this travel request and extract the
ordered list of single-hop legs (each leg is one source -> one destination).
For "X to Y then Z" output two legs: X->Y, then Y->Z.
For "stopover/break/halt/via M from X to Y" output two legs: X->M, then M->Y.
Detect cheapest / fastest / shortest preferences ("cheap" / "fast" / "best").
Detect a mode hint if the user asked specifically for flight or train ("flight" / "rail" / "any").
Detect any departure time window the user gives for a leg and convert to 24h HH:MM:
  - "after 6pm" / "evening"  -> depart_after "18:00"
  - "before noon" / "morning" -> depart_before "12:00"
  - "around 9am"             -> depart_after "08:00", depart_before "10:00"
  - "night"                  -> depart_after "20:00"
  - "afternoon"              -> depart_after "12:00", depart_before "17:00"
If the user gives a calendar date for a leg, output it as date "YYYY-MM-DD"; otherwise "".

User Request:
{user_prompt}

Return ONLY a JSON array. Each element must be exactly:
{{"from": "<city>", "to": "<city>", "mode_hint": "flight"|"rail"|"any", "prefer": "cheap"|"fast"|"best", "date": "<YYYY-MM-DD or empty>", "depart_after": "<HH:MM or empty>", "depart_before": "<HH:MM or empty>"}}
Use full city names (e.g. "Kolkata" not "CCU"). No markdown, no explanation, no extra keys.
Output must be parseable by Python json.loads()."""
    try:
        raw = ask_llm(prompt)
        cleaned = clean_json(raw)
        legs = json.loads(cleaned)
        if not isinstance(legs, list):
            return []
        out = []
        for leg in legs:
            if not isinstance(leg, dict):
                continue
            f = (leg.get("from") or "").strip()
            t = (leg.get("to") or "").strip()
            if not f or not t or f.lower() == t.lower():
                continue
            mode_hint = leg.get("mode_hint", "any")
            if mode_hint not in ("flight", "rail", "any"):
                mode_hint = "any"
            prefer = leg.get("prefer", "best")
            if prefer not in ("cheap", "fast", "best"):
                prefer = "best"
            out.append({
                "from": f,
                "to": t,
                "mode_hint": mode_hint,
                "prefer": prefer,
                "date": (leg.get("date") or "").strip(),
                "depart_after": (leg.get("depart_after") or "").strip(),
                "depart_before": (leg.get("depart_before") or "").strip(),
            })
        return out
    except Exception as e:
        print(f"[parse_legs] Error: {e} — falling back to single-leg interpretation")
        return []

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
    
    def run_leg(self, state: TravelState, from_loc: str, to_loc: str, prefer: str = "best",
                date: str = "", depart_after: str = "", depart_before: str = ""):
        """Generate ONE flight leg for an explicit from->to pair.
        Used by the multi-stop swarm so each leg gets a focused, grounded prompt."""
        self.log(state, f"Routing flight leg {from_loc} -> {to_loc} (prefer: {prefer})...")
        # Skip if this exact leg already exists
        if any(leg.type == "flight" and leg.from_location.lower() == from_loc.lower()
               and leg.to_location.lower() == to_loc.lower() for leg in state.current_itinerary):
            self.log(state, f"Flight leg {from_loc}->{to_loc} already present. Skipping.")
            return
        prefer_hint = {"cheap": "Choose the cheapest available option.",
                       "fast":  "Choose the fastest available option.",
                       "best":  "Balance speed and cost."}.get(prefer, "Balance speed and cost.")
        time_hint = _build_time_hint(date, depart_after, depart_before)
        try:
            response = ask_llm(f"""
            Generate a valid flight itinerary for ONE leg only.
            From: {from_loc}
            To: {to_loc}
            Preference: {prefer_hint}
            {time_hint}
            Use realistic Indian domestic flight durations and INR costs.
            departure_time and arrival_time must be 24-hour "HH:MM:SS".
            departure_date and arrival_date must be "YYYY-MM-DD".
            Return ONLY ONE valid JSON object — do not repeat, duplicate, or output multiple JSON blocks.
            Example format:
            {{
            "type":"flight",
            "mode":"air",
            "operator":" ",
            "identification_number":" ",
            "flight_name":" ",
            "from_location":"{from_loc}",
            "to_location":"{to_loc}",
            "departure_date":" ",
            "departure_time":" ",
            "arrival_date":" ",
            "arrival_time":" ",
            "cost": ,
            "status":"proposed"
            }}
            Output EXACTLY ONE JSON object. No markdown. No explanation. No trailing text after the closing brace. Output must be parseable by Python json.loads().""")
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
                self.log(state, f"LLM returned no valid flight leg for {from_loc}->{to_loc}.")
                return
            flight_json = normalize_leg(flight_json)
            # Force from/to to the requested values (LLM may have hallucinated)
            flight_json["from_location"] = from_loc
            flight_json["to_location"] = to_loc
            # Force the requested journey date if the user specified one.
            if date:
                flight_json["departure_date"] = date
                if not flight_json.get("arrival_date"):
                    flight_json["arrival_date"] = date
            # Normalize date formats to YYYY-MM-DD so validation never crashes.
            flight_json["departure_date"] = normalize_date(flight_json.get("departure_date", ""))
            flight_json["arrival_date"] = normalize_date(flight_json.get("arrival_date", "")) or flight_json["departure_date"]
            if flight_json.get("status") not in ("proposed", "confirmed"):
                flight_json["status"] = "proposed"
            flight_leg = ItineraryLeg(leg_index=len(state.current_itinerary), **flight_json)
            try:
                api_data = TravelData.get_live_flight(flight_leg.from_location, flight_leg.to_location)
                flight_leg.operator = api_data["real_operator"]
                flight_leg.identification_number = api_data["real_identification_no"]
            except Exception as api_e:
                self.log(state, f"Live flight lookup failed for {from_loc}->{to_loc}: {api_e}")
            state.current_itinerary.append(flight_leg)
            self.log(state, f"Proposed Flight: {flight_leg.from_location} -> {flight_leg.to_location}")
        except Exception as e:
            self.log(state, f"Error generating flight leg {from_loc}->{to_loc}: {str(e)}")

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
                rail_json = next((leg for leg in rail_data["itinerary"] if leg.get("type") in ["train", "rail"]), None)
            elif "legs" in rail_data:
                rail_json = next((leg for leg in rail_data["legs"] if leg.get("type") in ["train", "rail"]), None)
            elif "train" in rail_data and isinstance(rail_data["train"], dict):
                rail_json = rail_data["train"]
            elif "rail" in rail_data and isinstance(rail_data["rail"], dict):
                rail_json = rail_data["rail"]
            elif rail_data.get("type") in ("train", "rail"):
                rail_json = rail_data
            else:
                rail_json = None

            if rail_json is None:
                self.log(state, "LLM did not return a valid rail leg. Skipping rail.")
                return

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
    # City aliases so "Howrah"/"New Delhi" connect correctly to "Kolkata"/"Delhi".
    CITY_ALIASES = {
        "howrah": "kolkata",
        "new delhi": "delhi",
        "bengaluru": "bangalore",
        "bombay": "mumbai",
        "madras": "chennai",
        "calcutta": "kolkata",
    }

    # Minimum safe transfer buffer (minutes) between two consecutive legs,
    # keyed by (arriving_mode -> departing_mode). Domestic India — no customs.
    MIN_TRANSFER_MIN = {
        ("flight", "rail"): 120,   # land, exit airport, reach station
        ("flight", "flight"): 90,  # connecting flights
        ("rail", "flight"): 150,   # station -> airport + check-in
        ("rail", "rail"): 30,      # platform change
    }

    def _canon(self, city: str) -> str:
        c = (city or "").strip().lower()
        return self.CITY_ALIASES.get(c, c)

    def run(self, state: TravelState):
        self.log(state, "Executing cross-modal timeline validation...")
        state.validation_errors = []
        state.is_validated = False

        legs = list(state.current_itinerary)
        if not legs:
            state.validation_errors.append("No itinerary generated.")
            self.log(state, "Validation Rejection: no legs produced.")
            return

        # Validate in journey order.
        legs_sorted = sorted(legs, key=lambda l: l.leg_index)

        for i, leg in enumerate(legs_sorted):
            # Per-leg sanity: each leg must have endpoints and a non-negative cost.
            if not leg.from_location or not leg.to_location:
                state.validation_errors.append(
                    f"Leg {i+1} ({leg.type}) is missing an origin or destination."
                )
            if leg.cost is not None and leg.cost < 0:
                state.validation_errors.append(
                    f"Leg {i+1} ({leg.type}) has an invalid negative cost."
                )

            if i == 0:
                continue

            prev = legs_sorted[i - 1]

            # 1) Route continuity: this leg must start where the previous one ended.
            if self._canon(prev.to_location) != self._canon(leg.from_location):
                state.validation_errors.append(
                    f"Route Breach: leg {i+1} starts at '{leg.from_location}' but "
                    f"leg {i} ended at '{prev.to_location}'. The journey is not continuous."
                )

            # 2) Timeline continuity: this leg must depart after the previous one
            #    arrives, with a realistic transfer buffer for the mode change.
            prev_arr = parse_dt(prev.arrival_date, prev.arrival_time)
            this_dep = parse_dt(leg.departure_date, leg.departure_time)
            if prev_arr is None or this_dep is None:
                state.validation_errors.append(
                    f"Could not verify timing between leg {i} and leg {i+1} "
                    f"(unreadable date/time). Please re-run."
                )
            else:
                gap_min = (this_dep - prev_arr).total_seconds() / 60.0
                need = self.MIN_TRANSFER_MIN.get((prev.type, leg.type), 60)
                if gap_min < 0:
                    state.validation_errors.append(
                        f"Temporal Breach: leg {i+1} departs before leg {i} arrives "
                        f"({int(gap_min)} min)."
                    )
                elif gap_min < need:
                    state.validation_errors.append(
                        f"Temporal Breach: only {int(gap_min)} min between leg {i} "
                        f"({prev.type}) arrival and leg {i+1} ({leg.type}) departure — "
                        f"need at least {need} min for a safe {prev.type}->{leg.type} transfer."
                    )

        if not state.validation_errors:
            state.is_validated = True
            for leg in state.current_itinerary:
                leg.status = "confirmed"
            self.log(state, f"Cleared. {len(legs_sorted)}-leg itinerary is continuous and well-timed.")
        else:
            state.is_validated = False
            self.log(state, f"Validation Rejection: {state.validation_errors}")