# VOYAGER India — AI Travel Intelligence System

**Microsoft AI Build Challenge** · Team **Yatra Swarm**
Multi-agent system for India-focused travel intelligence — live monitoring, dynamic re-routing, and AI-generated multi-modal itineraries.

---

## Architecture

VOYAGER India runs as **two cooperating services**:

1. **Node.js Orchestrator + Dashboard** (`core/`, `public/`) — the central command layer. Monitors travel conditions across Indian cities in real time, drives the holographic India map, and routes natural-language commands to the right agent/tool.
2. **Itinerary Planning Swarm** (`backend/`, `Agents/`) — a FastAPI service running a dedicated swarm of LLM agents that generate, cross-validate, and self-correct multi-modal (flight + rail) itineraries.

The Orchestrator calls the swarm via a `run_itinerary_swarm` tool whenever a user asks to **plan a trip / build an itinerary**, and renders the validated result directly on the dashboard alongside live weather for the route's cities.

```
┌─────────────────────────────┐
│   WEB DASHBOARD              │  India map · agent panel · itinerary,
│   (public/dashboard.html)    │  weather & disruption views · WebSocket
└───────────────┬───────────────┘
                │
┌───────────────▼───────────────┐
│   ORCHESTRATOR                 │  Agentic tool-calling loop
│   (core/orchestrator.js)       │  17 tools incl. run_itinerary_swarm
└──────┬──────────────────┬─────┘
       │                  │
┌──────▼─────────┐  ┌─────▼────────────────────────┐
│ Monitoring      │  │ Itinerary Planning Swarm       │
│ Agents          │  │ (FastAPI · backend/server.py)  │
│ Weather/AQI ·   │  │ FlightAgent · RailAgent ·       │
│ Re-Router ·     │  │ ValidatorAgent — self-healing  │
│ Seismic ·       │  │ retry loop (up to 3 cycles)    │
│ Booking proxy   │  │                                 │
└─────────────────┘  └─────────────────────────────────┘
       │                          │
┌──────▼──────────────────────────▼─────────────────────┐
│  DATA & APIs: Open-Meteo · USGS · WAQI · AviationStack  │
│  IRCTC RapidAPI · GitHub Models (LLM, both layers)      │
└──────────────────────────────────────────────────────────┘
```

---

## Agent Network

| Agent | Role | Status |
|---|---|---|
| **Orchestrator** | Central intelligence. Interprets commands, coordinates all agents/tools. | ✅ Active |
| **Weather & Event Monitor** | Continuously tracks weather, AQI, cyclones, and flight delays for Indian cities. | ✅ Active |
| **Dynamic Re-Router** | Activates on disruptions. Surfaces alternative Indian routes (trains, alternate flights). | ✅ Active |
| **Itinerary Planner** | FastAPI swarm — `FlightAgent` + `RailAgent` draft multi-modal legs from natural language. | ✅ Active |
| **Validator** | `ValidatorAgent` cross-checks timeline/route consistency, triggers self-healing retries. | ✅ Active |

---

## India-Specific Features

- Interactive holographic India map — tap any city to inspect conditions
- 50+ Indian cities/airports indexed (DEL, BOM, BLR, MAA, CCU, HYD, COK, AMD, PNQ, GOI, and more)
- Monsoon / Cyclone awareness — Bay of Bengal & Arabian Sea tracking
- AQI/NAQI critical alerts for Delhi/Mumbai — hazardous PM2.5/PM10 thresholds
- Fog delay detection — North India winter fog flight delays
- Indian festival awareness — Diwali, Holi, IPL, Navratri, Kumbh Mela
- Domestic airlines — IndiGo, Air India, SpiceJet, Vistara, Akasa Air
- Indian Railways — Rajdhani, Shatabdi, Vande Bharat, Duronto and more
- **AI-generated multi-modal itineraries** — natural language → validated flight + rail plan with live corridor weather

---

## Setup

### 1. Node.js Orchestrator + Dashboard

```bash
git clone <repo>
cd voyager-agents
npm install
cp .env.example .env
```

Edit `.env` and add at least one LLM provider key (see [AI API](#ai-api) below), e.g.:

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
# or
OPENROUTER_API_KEY=sk-or-xxxxxxxxxxxxxxxx
# or
GROQ_API_KEY=gsk_xxxxxxxxxxxxxxxx
```

```bash
npm start
# Dashboard: http://localhost:7777
```

### 2. Itinerary Planning Swarm (FastAPI)

```bash
cd Voyager            # repo root (Agents/ and backend/ are siblings here)
python -m venv venv
venv\Scripts\activate        # Windows
# source venv/bin/activate   # macOS/Linux

pip install fastapi uvicorn pandas requests python-dotenv openai
```

Create `Agents/.env`:

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

Run the swarm API:

```bash
uvicorn backend.server:app --reload --port 8000
```

Both services must be running for "plan a trip" / itinerary commands to work. All other dashboard features (map, weather, AQI, routes, scan) work with the Node service alone.

---

## AI API

VOYAGER uses LLMs in **two places** — the Orchestrator's tool-calling loop, and the Itinerary Swarm's leg-generation agents. Both currently default to:

### GitHub Models (Currently In Use)

- **Free**, Microsoft-affiliated, OpenAI-compatible endpoint (`https://models.inference.ai.azure.com`)
- Model: `gpt-4o-mini` — fast, reliable structured-JSON output, proper tool-calling
- Get a token: GitHub → Settings → Developer settings → Personal access tokens → **Tokens (classic)** (no special scopes needed)
- Set `GITHUB_TOKEN` in **both** `.env` (repo root, for Node) and `Agents/.env` (for the swarm)

### OpenRouter (fallback, Node orchestrator only)

- Free tier — auto-discovers currently-free tool-capable models
- Subject to daily rate limits on the free tier
- Get key: https://openrouter.ai/keys

### Groq (fallback, both layers)

- Free tier, LLaMA 3.3 70B
- Get key: https://console.groq.com

> If `GITHUB_TOKEN` is set, it takes priority for both the Orchestrator and the Itinerary Swarm. OpenRouter/Groq remain as automatic fallbacks for the Orchestrator if GitHub Models is unavailable.

---

## Usage

### From the Dashboard (GUI)

- Click any city pin on the India map → auto-inspects that city (weather, AQI, disruptions, routes)
- **Quick Inspect** buttons on the left panel for major cities
- Command bar at the bottom for natural language:
  - `route delhi to mumbai` · `cheapest ccu to blr` · `weather in kolkata` · `scan`
  - **`plan a trip from Kolkata to Delhi then train to Agra`** → triggers the Itinerary Swarm

### From the Shell (CLI)

```
monitor Mumbai next week
check air quality Delhi
flights from Delhi to Mumbai
any cyclone warnings near Chennai
events in Goa this weekend
plan a trip from Howrah to Bhubaneswar by train
```

---

## Tech Stack

- **AI**: GitHub Models (GPT-4o-mini) — currentlt in use for both Orchestrator and Itinerary Swarm; OpenRouter (free tool-capable models) and Groq (LLaMA 3.3 70B) as fallbacks
- **Itinerary Swarm**: Python · FastAPI · Pydantic · `FlightAgent` / `RailAgent` / `ValidatorAgent` with self-healing retry loop, date/enum normalization safeguards
- **Weather**: Open-Meteo (free, no key) + wttr.in fallback
- **AQI**: Open-Meteo Air Quality API (free) + WAQI ground-station cross-check
- **Seismic**: USGS Earthquake API (free)
- **Live flights/trains**: AviationStack + IRCTC RapidAPI (proxied server-side, with reference-schedule fallback)
- **Dashboard**: Vanilla JS + WebSocket (real-time)
- **Backend**: Node.js (orchestrator + WS server) + Python/FastAPI (itinerary swarm)