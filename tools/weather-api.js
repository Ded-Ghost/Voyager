'use strict';
const fetch = require('node-fetch');

const WTTR_BASE = 'https://wttr.in';

/**
 * Fetch real-time weather + 3-day forecast from wttr.in (free, no API key).
 * Falls back to AviationStack if AVIATIONSTACK_API_KEY is set, for flight delays.
 */
async function fetchWeather(location, days = 3) {
  const url = `${WTTR_BASE}/${encodeURIComponent(location)}?format=j1`;

  let raw;
  try {
    const res = await fetch(url, { timeout: 12000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    throw new Error(`Weather fetch failed for "${location}": ${err.message}`);
  }

  const current = raw.current_condition[0];

  const forecast = raw.weather.slice(0, days).map((day) => {
    const hourly = day.hourly || [];
    const midday = hourly[4] || hourly[0] || {};

    const totalRainfallMm = hourly.reduce((sum, h) => sum + parseFloat(h.precipMM || 0), 0);
    const maxRain   = Math.max(...hourly.map(h => parseInt(h.chanceofrain   || 0)));
    const maxWind   = Math.max(...hourly.map(h => parseInt(h.windspeedKmph  || 0)));
    const maxSnow   = Math.max(...hourly.map(h => parseInt(h.chanceofsnow   || 0)));
    const maxThund  = Math.max(...hourly.map(h => parseInt(h.chanceofthunder || 0)));

    const desc = (midday.weatherDesc?.[0]?.value || 'Unknown').toLowerCase();
    const isStorm = /storm|hurricane|typhoon|blizzard|severe/.test(desc);

    return {
      date:             day.date,
      maxTempC:         parseInt(day.maxtempC),
      minTempC:         parseInt(day.mintempC),
      description:      midday.weatherDesc?.[0]?.value || 'Unknown',
      totalRainfallMm:  parseFloat(totalRainfallMm.toFixed(1)),
      maxChanceOfRain:  maxRain,
      maxChanceOfSnow:  maxSnow,
      maxChanceOfThunder: maxThund,
      maxWindKmph:      maxWind,
      uvIndex:          parseInt(day.uvIndex || 0),
      isAlertDay:       maxRain > 65 || maxWind > 50 || isStorm,
      isStorm,
    };
  });

  const alerts = [];
  forecast.forEach((day, i) => {
    const label = `Day ${i + 1} (${day.date})`;
    if (day.isStorm)
      alerts.push({ day: label, type: 'storm',   severity: 'critical', detail: `Storm conditions: ${day.description}` });
    else if (day.maxChanceOfRain > 65)
      alerts.push({ day: label, type: 'rain',    severity: day.maxChanceOfRain > 80 ? 'high' : 'medium', detail: `${day.maxChanceOfRain}% chance of rain` });
    if (day.maxWindKmph > 50)
      alerts.push({ day: label, type: 'wind',    severity: 'high',    detail: `Strong winds: ${day.maxWindKmph} km/h` });
  });

  return {
    location,
    current: {
      tempC:       parseInt(current.temp_C),
      feelsLikeC:  parseInt(current.FeelsLikeC),
      condition:   current.weatherDesc?.[0]?.value || 'Unknown',
      humidity:    parseInt(current.humidity),
      windKmph:    parseInt(current.windspeedKmph),
      visibility:  parseInt(current.visibility),
    },
    forecast,
    alerts,
    hasActiveAlerts: alerts.length > 0,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Flight delay risk assessment.
 * Uses AviationStack API if key is set, otherwise infers from weather.
 */
async function checkFlightDelays(destination, departureDate) {
  if (process.env.AVIATIONSTACK_API_KEY) {
    try {
      const res = await fetch(
        `http://api.aviationstack.com/v1/flights?access_key=${process.env.AVIATIONSTACK_API_KEY}&dep_iata=${destination}&limit=10`,
        { timeout: 8000 }
      );
      const data = await res.json();
      const delays = (data.data || []).filter(f => f.departure?.delay > 30);
      const risk = delays.length > 3 ? 'High' : delays.length > 0 ? 'Medium' : 'Low';
      return { destination, risk, delayedFlights: delays.length, source: 'AviationStack', checkedAt: new Date().toISOString() };
    } catch (_) {}
  }

  // No API key — return informational result
  return {
    destination,
    risk: 'Unknown',
    message: 'Add AVIATIONSTACK_API_KEY to .env for live delay data. Check airline directly.',
    source: 'manual',
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Local events search.
 * Uses Ticketmaster Discovery API if key is set, otherwise returns placeholder.
 */
async function searchLocalEvents(location, dateFrom, dateTo) {
  if (process.env.TICKETMASTER_API_KEY) {
    try {
      const params = new URLSearchParams({
        apikey: process.env.TICKETMASTER_API_KEY,
        city:   location.split(',')[0].trim(),
        startDateTime: dateFrom ? `${dateFrom}T00:00:00Z` : undefined,
        endDateTime:   dateTo   ? `${dateTo}T23:59:59Z`   : undefined,
        size: 5,
      });
      const res  = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`, { timeout: 8000 });
      const data = await res.json();
      const events = (data._embedded?.events || []).map(e => ({
        name:  e.name,
        date:  e.dates?.start?.localDate,
        type:  e.classifications?.[0]?.segment?.name || 'Event',
        venue: e._embedded?.venues?.[0]?.name,
        impact: 'Medium',
      }));
      return { location, events, source: 'Ticketmaster' };
    } catch (_) {}
  }

  return {
    location,
    events: [],
    message: 'Add TICKETMASTER_API_KEY to .env for live event data.',
    source: 'placeholder',
  };
}

module.exports = { fetchWeather, checkFlightDelays, searchLocalEvents };
