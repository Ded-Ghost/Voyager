'use strict';
const fetch = require('node-fetch');

// Free, no API key needed. Excellent data quality.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

const _geocodeCache = new Map();

async function geocode(location) {
  if (_geocodeCache.has(location)) return _geocodeCache.get(location);
  const url = `${GEOCODE_URL}?name=${encodeURIComponent(location)}&count=1&format=json`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) throw new Error(`Geocoding failed: HTTP ${res.status}`);
  const data = await res.json();
  if (!data.results?.length) throw new Error(`Location not found: ${location}`);
  const r = data.results[0];
  const result = {
    lat: r.latitude, lon: r.longitude,
    name: r.name, country: r.country, timezone: r.timezone,
  };
  _geocodeCache.set(location, result);
  return result;
}

async function fetchEnhancedForecast(location, days = 3) {
  const geo = await geocode(location);
  const params = new URLSearchParams({
    latitude: geo.lat, longitude: geo.lon,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,weather_code,sunrise,sunset',
    hourly: 'temperature_2m,precipitation_probability,wind_speed_10m',
    timezone: geo.timezone || 'auto',
    forecast_days: Math.min(days, 16),
  });
  const res = await fetch(`${FORECAST_URL}?${params}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`Forecast failed: HTTP ${res.status}`);
  const data = await res.json();

  const wmoToDescription = {
    0:'Clear sky',1:'Mainly clear',2:'Partly cloudy',3:'Overcast',
    45:'Fog',48:'Depositing rime fog',
    51:'Light drizzle',53:'Moderate drizzle',55:'Dense drizzle',
    61:'Slight rain',63:'Moderate rain',65:'Heavy rain',
    71:'Slight snow',73:'Moderate snow',75:'Heavy snow',77:'Snow grains',
    80:'Slight rain showers',81:'Moderate rain showers',82:'Violent rain showers',
    85:'Slight snow showers',86:'Heavy snow showers',
    95:'Thunderstorm',96:'Thunderstorm with hail',99:'Thunderstorm with heavy hail',
  };

  const forecast = data.daily.time.map((date, i) => {
    const code = data.daily.weather_code[i];
    const desc = wmoToDescription[code] || 'Unknown';
    const isSevere = code >= 95 || code === 82 || code === 75 || code === 86;
    return {
      date,
      description: desc,
      weatherCode: code,
      maxTempC: data.daily.temperature_2m_max[i],
      minTempC: data.daily.temperature_2m_min[i],
      precipitationMm: data.daily.precipitation_sum[i],
      maxChanceOfRain: data.daily.precipitation_probability_max[i] || 0,
      maxWindKmph: Math.round(data.daily.wind_speed_10m_max[i] || 0),
      maxGustKmph: Math.round(data.daily.wind_gusts_10m_max[i] || 0),
      uvIndex: data.daily.uv_index_max[i] || 0,
      sunrise: data.daily.sunrise[i],
      sunset: data.daily.sunset[i],
      isSevere,
      isAlertDay: (data.daily.precipitation_probability_max[i] || 0) > 65 ||
                  (data.daily.wind_speed_10m_max[i] || 0) > 50 || isSevere,
    };
  });

  const alerts = [];
  forecast.forEach((d, i) => {
    const tag = `Day ${i + 1} (${d.date})`;
    if (d.isSevere)
      alerts.push({ day: tag, type: 'severe_weather', severity: 'critical', detail: d.description });
    if (d.maxChanceOfRain > 65)
      alerts.push({ day: tag, type: 'rain', severity: d.maxChanceOfRain > 85 ? 'high' : 'medium', detail: `${d.maxChanceOfRain}% precipitation probability` });
    if (d.maxWindKmph > 50)
      alerts.push({ day: tag, type: 'wind', severity: d.maxGustKmph > 80 ? 'high' : 'medium', detail: `Wind ${d.maxWindKmph} km/h, gusts ${d.maxGustKmph} km/h` });
    if (d.uvIndex >= 8)
      alerts.push({ day: tag, type: 'uv', severity: 'medium', detail: `UV index ${d.uvIndex} — extreme` });
  });

  return {
    location: `${geo.name}, ${geo.country}`,
    coordinates: { lat: geo.lat, lon: geo.lon },
    timezone: geo.timezone,
    source: 'Open-Meteo',
    forecast,
    alerts,
    hasActiveAlerts: alerts.length > 0,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAirQuality(location) {
  const geo = await geocode(location);
  const params = new URLSearchParams({
    latitude: geo.lat, longitude: geo.lon,
    current: 'european_aqi,us_aqi,pm10,pm2_5,carbon_monoxide,nitrogen_dioxide,ozone',
    timezone: geo.timezone || 'auto',
  });
  const res = await fetch(`${AIR_QUALITY_URL}?${params}`, { timeout: 8000 });
  if (!res.ok) throw new Error(`AQI failed: HTTP ${res.status}`);
  const data = await res.json();
  const c = data.current;
  const usAqi = c.us_aqi;

  let category, recommendation;
  if (usAqi <= 50)       { category = 'Good';                          recommendation = 'Air quality is satisfactory. No restrictions.'; }
  else if (usAqi <= 100) { category = 'Moderate';                      recommendation = 'Unusually sensitive people should consider limiting outdoor exertion.'; }
  else if (usAqi <= 150) { category = 'Unhealthy for sensitive groups'; recommendation = 'Sensitive groups should reduce outdoor activity.'; }
  else if (usAqi <= 200) { category = 'Unhealthy';                     recommendation = 'Everyone should reduce outdoor exertion. Consider indoor activities.'; }
  else if (usAqi <= 300) { category = 'Very Unhealthy';                recommendation = 'Avoid prolonged outdoor exertion. Wear N95 mask outside.'; }
  else                   { category = 'Hazardous';                     recommendation = 'Stay indoors. Air filtration recommended.'; }

  return {
    location: `${geo.name}, ${geo.country}`,
    usAqi, europeanAqi: c.european_aqi,
    category, recommendation,
    pollutants: { pm25: c.pm2_5, pm10: c.pm10, co: c.carbon_monoxide, no2: c.nitrogen_dioxide, ozone: c.ozone },
    isAlertLevel: usAqi > 100,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { geocode, fetchEnhancedForecast, fetchAirQuality };
