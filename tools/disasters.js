'use strict';
const fetch = require('node-fetch');
const { geocode } = require('./open-meteo');

// USGS Earthquake API — free, no key. Real-time global data.
const USGS_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary';

async function checkEarthquakes(location, radiusKm = 500, minMagnitude = 2.5) {
  const geo = await geocode(location);
  // Past day, magnitude 2.5+
  const url = `${USGS_FEED}/2.5_day.geojson`;
  const res = await fetch(url, { timeout: 8000 });
  if (!res.ok) throw new Error(`USGS feed failed: HTTP ${res.status}`);
  const data = await res.json();

  const nearby = data.features
    .map(f => {
      const [lon, lat] = f.geometry.coordinates;
      const dist = haversine(geo.lat, geo.lon, lat, lon);
      return {
        magnitude: f.properties.mag,
        place: f.properties.place,
        time: new Date(f.properties.time).toISOString(),
        depthKm: f.geometry.coordinates[2],
        tsunami: f.properties.tsunami === 1,
        distanceKm: Math.round(dist),
        lat, lon,
        url: f.properties.url,
      };
    })
    .filter(q => q.distanceKm <= radiusKm && q.magnitude >= minMagnitude)
    .sort((a, b) => b.magnitude - a.magnitude);

  const significant = nearby.filter(q => q.magnitude >= 5.0);
  const tsunami = nearby.some(q => q.tsunami);

  let alertLevel = 'none';
  if (tsunami) alertLevel = 'critical';
  else if (significant.length > 0) alertLevel = 'high';
  else if (nearby.length > 3) alertLevel = 'medium';

  return {
    location: `${geo.name}, ${geo.country}`,
    radiusKm,
    totalNearby: nearby.length,
    significant: significant.length,
    tsunamiAlert: tsunami,
    earthquakes: nearby.slice(0, 10),
    alertLevel,
    isAlertLevel: alertLevel !== 'none',
    fetchedAt: new Date().toISOString(),
  };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = { checkEarthquakes };
