# Airpath — Smart Commute Router

A responsive SaaS-style prototype for choosing a route with lower estimated air-pollution exposure, not only the shortest travel time.

## Features

- Route comparison: **The greener way**, **The balanced route**, and **The fast lane**.
- Commute-mode toggle for cycling, walking, and running.
- Editable origin and destination with swap and plan interactions.
- City selector for New Delhi, Mumbai, Bengaluru, and London.
- Optional browser geolocation for a current coordinate-level AQI lookup.
- Live city/coordinate-level US AQI, PM2.5, PM10, NO₂, and ozone readings from the Open-Meteo Air Quality API when the API is reachable, with clearly labeled sample fallback values.
- Exposure report, pollutant summary, saved route list, responsive mobile navigation, and route-selection state.

## Run locally

Requires Node.js 20+ and npm.

```bash
npm install
npm run dev
```

To verify a production build:

```bash
npm run build
npm run preview
```

## Important prototype limitations

This is a front-end concept prototype. The map is an **illustrative route diagram**, not a geographically accurate basemap. The route times, route distances, air scores, and relative exposure percentages are sample estimates used to demonstrate the product experience; they are not calculated from a real pedestrian/cycling routing engine and are not a measured personal pollution dose. The live Open-Meteo reading is regional/coordinate-level context, not street-by-street pollution data. “Start navigation” is intentionally a placeholder.

For a production version, replace the illustrative paths and sample route scores with a real routing provider (for example, an OSM-based cycling/walking router), map-match its route geometry, sample air-quality and traffic data along each candidate route, and rank candidate routes using time, exertion, and estimated pollutant exposure. Calibrate/validate the exposure model and clearly communicate uncertainty.

## Data source

- [Open-Meteo Air Quality API](https://open-meteo.com/en/docs/air-quality-api) — live AQI and pollutant fields when available. No API key is embedded in the prototype.
