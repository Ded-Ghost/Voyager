# VOYAGER — Travel Intelligence System
### Microsoft AI Build Challenge · v2.5

A persistent, command-driven AI agent system. Type natural-language commands in the
terminal or the holographic web dashboard. Click any country on the globe to monitor it.
The agent does real work on your local machine — file system, clipboard, calendar files,
desktop notifications, voice output.

---

## Boot it

```bash
npm install
cp .env.example .env       # add ANTHROPIC_API_KEY
node index.js              # ← that's it
```

VOYAGER comes online with:
- **Holographic dashboard** at http://localhost:7777 (auto-opens in your browser)
- **Interactive shell** in your terminal: `VOYAGER ▸ `
- **Voice output** speaking key messages aloud (via system TTS)

Both surfaces accept the same natural-language commands and stay in sync.

---

## Talk to it

Just type in plain English — at the terminal prompt or in the dashboard command bar.
Or click any country on the spinning globe to monitor it instantly.

```
VOYAGER ▸ monitor Tokyo for next week
VOYAGER ▸ what's the air quality in Delhi
VOYAGER ▸ any earthquakes near Istanbul
VOYAGER ▸ save Paris trip Jun 15-20 to my calendar
VOYAGER ▸ copy the alert summary to clipboard
VOYAGER ▸ open the alerts file
VOYAGER ▸ show me the current status
VOYAGER ▸ force a disruption test
VOYAGER ▸ go quiet
VOYAGER ▸ speak again
```

---

## What it can actually do on your machine

| Tool | What |
|---|---|
| `fetch_weather` | Open-Meteo + wttr.in fallback (live forecasts, no API key) |
| `fetch_air_quality` | Real-time AQI, PM2.5, PM10 from Open-Meteo |
| `check_seismic_activity` | USGS earthquake feed within 500km radius |
| `check_flight_delays` | AviationStack (if key set) |
| `search_local_events` | Ticketmaster (if key set) |
| `compare_with_memory` | Detects deltas vs previous runs for same destination |
| `write_alert_log` | Persists to `data/alerts.json` |
| `write_monitoring_state` | Updates `data/monitoring-state.json` |
| `signal_rerouter` | Writes `data/disruption-signal.json` (IPC to Re-Router) |
| `send_system_notification` | Native Windows/macOS/Linux desktop notification |
| `speak` | System TTS — `say` / PowerShell / `spd-say` |
| `set_voice` | Toggle TTS at runtime |
| `write_clipboard` / `read_clipboard` | OS clipboard access |
| `open_file_or_app` | Open files, folders, apps, URLs cross-platform |
| `generate_calendar` | Writes `.ics` to `data/calendars/` — double-click to import |
| `play_sound_cue` | Triggers UI sound effects on the dashboard |
| `read_monitoring_state` / `read_recent_alerts` | Read state back out |

---

## The dashboard

Open at http://localhost:7777. It's a single page with:

- **3D globe** (dark Earth, cyan atmosphere) — slowly rotates in standby
- **Click any country** → fires `monitor <country>` automatically
- **Pin drop + camera lock-on** when a destination is monitored
- **Pulsing red rings** at earthquake epicenters from the USGS feed
- **HUD panels** — agent network, telemetry, forecast, AQI, seismic
- **Activity feed** — every tool call, every reply, in real time
- **Command bar** at the bottom — type commands here just like the terminal
- **Voice bubble** — what VOYAGER is saying right now
- **Sound effects** (toggleable) — boot chime, lock-on sweep, alert beeps
- **Voice mute toggle** — top-right mic icon

Endpoints:
- `GET /`             — dashboard
- `GET /health`       — uptime, connected clients
- `GET /api/state`    — JSON state snapshot
- `WS  /`             — live event stream + incoming commands

---

## How the agent network communicates

Inter-agent IPC via JSON files in `./data/` (cross-process, no message bus needed):

```
data/
├── alerts.json            ← every alert ever logged
├── monitoring-state.json  ← current system status
├── disruption-signal.json ← activates Re-Router (5s polling)
├── agent-memory.json      ← snapshots for change detection
├── token-metrics.json     ← per-run API usage
└── calendars/             ← generated .ics files
```

Partner agents (Itinerary Planner + Booking) write to `./itineraries/`.

---

## Re-Router activation thresholds

| Condition | Threshold |
|---|---|
| Precipitation | > 65% chance on any travel day |
| Wind | > 50 km/h |
| Severe weather | storm / hurricane / typhoon / blizzard |
| Flight delay risk | "High" |
| AQI | > 150 |
| Seismic | M5.0+ within 500km OR tsunami warning |

---

## API keys (only Anthropic is required)

| Service | Required | Free tier | Where |
|---|---|---|---|
| Anthropic | ✅ | — | console.anthropic.com |
| Open-Meteo (weather + AQI) | ❌ | Built-in, no key | — |
| wttr.in (fallback) | ❌ | Built-in, no key | — |
| USGS (earthquakes) | ❌ | Built-in, no key | — |
| Ticketmaster | Optional | 5 req/sec | developer.ticketmaster.com |
| AviationStack | Optional | 100 req/mo | aviationstack.com |

---

## Project structure

```
voyager-agents/
├── core/
│   ├── orchestrator.js     ← The brain — handles every command
│   ├── shell.js            ← Interactive terminal REPL
│   ├── dashboard.js        ← Express + WebSocket server
│   ├── personality.js      ← Orchestrator system prompt
│   ├── display.js          ← Terminal UI
│   ├── ipc.js              ← File-based inter-agent IPC
│   └── memory.js           ← Persistent memory + change detection + metrics
├── tools/
│   ├── open-meteo.js       ← Weather + air quality
│   ├── disasters.js        ← USGS earthquakes
│   ├── weather-api.js      ← wttr.in fallback
│   ├── notifications.js    ← Desktop notifications
│   └── system-actions.js   ← TTS, clipboard, open, .ics
├── public/
│   └── dashboard.html      ← Holographic globe dashboard
├── data/                   ← Runtime state (auto-created)
└── index.js                ← Entry point — `node index.js`
```

---

## Built-in shell commands

| | |
|---|---|
| `/help`  | List built-ins and example natural-language commands |
| `/clear` | Clear the terminal |
| `/exit`  | Shut down VOYAGER |

Everything else goes through the agent. Just talk to it.

---

*Phase 2: Dynamic Re-Router Agent — runs in a separate process, watches `disruption-signal.json`, re-plans on activation.*
