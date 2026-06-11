# VOYAGER India — AI Travel Intelligence System

> **Microsoft AI Build Challenge** · Multi-agent system for India-focused travel intelligence

## Architecture

VOYAGER India is a multi-agent system that monitors travel conditions across Indian cities in real-time.

### Agent Network (5 Agents)

| Agent | Role | Status |
|---|---|---|
| **Orchestrator** | Central intelligence. Interprets commands, coordinates all agents. | ✅ Active |
| **Weather & Event Monitor** | Continuously tracks weather, AQI, cyclones, and flight delays for Indian cities. | ✅ Active |
| **Dynamic Re-Router** | Activates on disruptions. Coordinates with Planner/Booking to find alternative Indian routes (trains, alternate flights). | ✅ Active |
| **Itinerary Planner** | Drafts day-by-day schedules based on preferences, budget, and Indian festivals/events. | 🔗 Partner |
| **Booking & Logistics** | Finds flights (IndiGo, Air India, Vistara), trains (Rajdhani, Vande Bharat), hotels. | 🔗 Partner |

### India-Specific Features

- **Interactive holographic India map** — tap any city to inspect conditions
- **10 major Indian airports** monitored: DEL, BOM, BLR, MAA, CCU, HYD, COK, AMD, PNQ, GOI
- **Monsoon / Cyclone awareness** — Bay of Bengal & Arabian Sea tracking
- **AQI critical for Delhi/Mumbai** — hazardous air quality alerts (PM2.5/PM10)
- **Fog delay detection** — North India winter fog flight delays
- **Indian festival awareness** — Diwali, Holi, IPL, Navratri, Kumbh Mela
- **Domestic airlines** — IndiGo, Air India, SpiceJet, Vistara, Akasa Air
- **Indian Railways** — Rajdhani, Shatabdi, Vande Bharat as fallback routes

## Setup

```bash
# 1. Clone & install
git clone <repo>
cd voyager-agents
npm install

# 2. Get your FREE Gemini API key
# Visit: https://aistudio.google.com/apikey
# Copy the key

# 3. Configure
cp .env.example .env
# Edit .env → paste your GEMINI_API_KEY

# 4. Launch
npm start
# Opens dashboard at http://localhost:7777
```

## AI API — Zero Cost

**Google Gemini 2.0 Flash** (recommended, primary):
- Completely FREE tier — no credit card needed
- 15 RPM, 1M tokens/day free
- Excellent tool-use / function-calling support
- Get key: https://aistudio.google.com/apikey

**Groq** (fallback):
- Free tier available with rate limits
- LLaMA 3.3 70B model
- Get key: https://console.groq.com

## Usage

### From the Dashboard (GUI)
1. **Click any city pin** on the India map → auto-inspects that city
2. **Quick Inspect buttons** on the left panel for major cities
3. **Command bar** at the bottom for natural language commands

### From the Shell (CLI)
```
monitor Mumbai next week
check air quality Delhi
flights from Delhi to Mumbai
any cyclone warnings near Chennai
events in Goa this weekend
```

## Tech Stack

- **AI**: Google Gemini 2.0 Flash (free) / Groq LLaMA (fallback)
- **Weather**: Open-Meteo (free, no key) + wttr.in fallback
- **AQI**: Open-Meteo Air Quality API (free)
- **Seismic**: USGS Earthquake API (free)
- **Dashboard**: Vanilla JS + WebSocket (real-time)
- **Backend**: Node.js + Express-style WS server
