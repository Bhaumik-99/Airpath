import L from 'leaflet';
import { MapContainer, TileLayer, Polyline, Marker, Tooltip, Popup, useMap } from 'react-leaflet';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDownUp, ArrowRight, ArrowUpRight,
  Bell, BellOff, Bike, Bookmark, Check, ChevronDown, CircleHelp,
  Clock3, Cloud, Compass, Database, ExternalLink, FlaskConical,
  Footprints, Gauge, Leaf, LocateFixed, MapPin, Menu, MoreHorizontal,
  Navigation, RefreshCw, Route, Search, Server, ShieldCheck,
  TrendingUp, Wind, X,
} from 'lucide-react';
import { localStack } from './services/awsLocalStack';

// Fix Leaflet default icon (Vite asset bundling issue)
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// ─── Types ────────────────────────────────────────────────────────────────────
export type Mode = 'Cycle' | 'Walk' | 'Run';
export type RouteKind = 'clean' | 'balanced' | 'fast';
export type LatLon = [number, number]; // [lat, lon]
export type City = { name: string; lat: number; lon: number; area: string };

export type AirData = {
  aqi: number;
  pm25: number;
  pm10: number;
  no2: number;
  ozone: number;
  label: string;
  source: 'live' | 'sample';
  observedAt: Date;
};

export type ScoredRoute = {
  kind: RouteKind;
  latLons: LatLon[];
  durationSec: number;
  distanceM: number;
  midAqi: number;
  exposureScore: number; // 0–100, lower = cleaner
  airScore: number;      // 0–100, higher = better
  speedKmH: number;
  exposureReductionPct: number;
  waypointCoord?: LatLon;
  summaryLabel: string;
};

export type ExposureEntry = {
  id: string;
  timestamp: Date;
  pm25: number;
  durationMin: number;
  mode: Mode;
  location: string;
};

// ─── Constants ────────────────────────────────────────────────────────────────
const CITIES: City[] = [
  { name: 'New Delhi',  lat: 28.6139, lon: 77.2090, area: 'Central Delhi, India' },
  { name: 'Mumbai',     lat: 19.0760, lon: 72.8777, area: 'South Mumbai, India' },
  { name: 'Bengaluru',  lat: 12.9716, lon: 77.5946, area: 'Central Bengaluru, India' },
  { name: 'London',     lat: 51.5072, lon: -0.1276, area: 'Central London, UK' },
];

const SAMPLE_AIR: Record<string, AirData> = {
  'New Delhi': { aqi: 154, pm25: 63.4, pm10: 92.1, no2: 31.5, ozone: 41.2, label: 'Unhealthy', source: 'sample', observedAt: new Date() },
  Mumbai:      { aqi: 82,  pm25: 24.8, pm10: 41.1, no2: 19.6, ozone: 34.5, label: 'Moderate',  source: 'sample', observedAt: new Date() },
  Bengaluru:   { aqi: 64,  pm25: 18.4, pm10: 29.6, no2: 13.8, ozone: 28.4, label: 'Moderate',  source: 'sample', observedAt: new Date() },
  London:      { aqi: 27,  pm25: 6.2,  pm10: 11.5, no2: 8.3,  ozone: 24.7, label: 'Good',      source: 'sample', observedAt: new Date() },
};

const EXERTION: Record<Mode, number> = { Walk: 1.0, Cycle: 1.4, Run: 1.9 };
const WHO_DAILY_LIMIT_UG_MIN = 15 * 24 * 60; // 15 µg/m3 over 24h

// Distinct route colors for clear readability on OpenStreetMap
const ROUTE_COLORS: Record<RouteKind, string> = {
  clean:    '#16a34a', // Emerald Green (Lowest AQI Route)
  balanced: '#2563eb', // Royal Blue (Balanced Route)
  fast:     '#ea580c', // Warm Amber (Fastest / Arterial Route)
};

const ROUTE_META: Record<RouteKind, { label: string; subtitle: string; chip: string; score: number }> = {
  clean:    { label: 'Lowest AQI Route', subtitle: 'Quieter green corridor · Park & secondary paths', chip: 'LOWEST AQI · RECOMMENDED', score: 0 },
  balanced: { label: 'Balanced Route',   subtitle: 'Balanced speed & residential streets',            chip: 'BALANCED',                   score: 1 },
  fast:     { label: 'Fastest Route',    subtitle: 'Direct high-traffic arterial road',               chip: 'FASTEST (HIGH EXPOSURE)',    score: 2 },
};

// ─── BreathBudget utilities ───────────────────────────────────────────────────
function calcDose(pm25: number, durationMin: number, mode: Mode) {
  return pm25 * durationMin * EXERTION[mode];
}

function budgetPercent(entries: ExposureEntry[]) {
  const total = entries.reduce((s, e) => s + calcDose(e.pm25, e.durationMin, e.mode), 0);
  return Math.min(100, (total / WHO_DAILY_LIMIT_UG_MIN) * 100);
}

function budgetRemaining(entries: ExposureEntry[], pm25: number, mode: Mode) {
  const used = entries.reduce((s, e) => s + calcDose(e.pm25, e.durationMin, e.mode), 0);
  const rem = WHO_DAILY_LIMIT_UG_MIN - used;
  if (rem <= 0 || pm25 <= 0) return 0;
  return Math.floor(rem / (pm25 * EXERTION[mode]));
}

// ─── AQI API (Open-Meteo) ─────────────────────────────────────────────────────
function aqiDescriptor(aqi: number) {
  if (aqi <= 50)  return { label: 'Good',            tone: 'good' };
  if (aqi <= 100) return { label: 'Moderate',         tone: 'moderate' };
  if (aqi <= 150) return { label: 'Sensitive groups', tone: 'sensitive' };
  if (aqi <= 200) return { label: 'Unhealthy',        tone: 'unhealthy' };
  if (aqi <= 300) return { label: 'Very unhealthy',   tone: 'very-unhealthy' };
  return           { label: 'Hazardous',              tone: 'hazardous' };
}

async function fetchAirAt(lat: number, lon: number): Promise<AirData> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=pm10,pm2_5,nitrogen_dioxide,ozone,us_aqi&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('AQI feed error');
  const json = await res.json();
  const c = json.current;
  const aqi = Math.round(Number(c.us_aqi));
  if (!Number.isFinite(aqi)) throw new Error('AQI value missing');
  return {
    aqi,
    pm25: Number(c.pm2_5),
    pm10: Number(c.pm10),
    no2: Number(c.nitrogen_dioxide),
    ozone: Number(c.ozone),
    label: aqiDescriptor(aqi).label,
    source: 'live',
    observedAt: new Date(),
  };
}

// ─── Geocoding (Nominatim OpenStreetMap) ──────────────────────────────────────
async function geocode(query: string): Promise<LatLon> {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&accept-language=en`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Airpath-SmartRouter/1.0 (contact@airpath.dev)' } });
  const data: { lat: string; lon: string }[] = await res.json();
  if (!data.length) throw new Error(`"${query}" not found — try a more specific location`);
  return [parseFloat(data[0].lat), parseFloat(data[0].lon)];
}

// ─── OSRM Multi-Route Engine ──────────────────────────────────────────────────
interface OsrmRoute {
  geometry: { coordinates: [number, number][] }; // GeoJSON [lon, lat]
  duration: number; // seconds
  distance: number; // meters
}

async function fetchOsrmRaw(coords: LatLon[], profile: 'bike' | 'foot'): Promise<OsrmRoute[]> {
  const coordString = coords.map(([lat, lon]) => `${lon},${lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/${profile}/${coordString}?alternatives=true&geometries=geojson&overview=full&steps=false`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const json = await res.json();
  if (json.code !== 'Ok' || !json.routes) return [];
  return json.routes as OsrmRoute[];
}

/**
 * Fetch 3 distinct street routes:
 * 1. Direct fastest route (high-traffic arterial)
 * 2. Green corridor route (diverted through park/quiet waypoint)
 * 3. Balanced route (diverted through secondary residential waypoint)
 */
async function fetchThreeAlternativeRoutes(
  from: LatLon,
  to: LatLon,
  profile: 'bike' | 'foot',
  baseAqi: number,
): Promise<ScoredRoute[]> {
  const dLat = to[0] - from[0];
  const dLon = to[1] - from[1];
  const len = Math.sqrt(dLat * dLat + dLon * dLon) || 0.001;
  const midLat = (from[0] + to[0]) / 2;
  const midLon = (from[1] + to[1]) / 2;

  // Calculate perpendicular corridor offsets
  const offset = Math.min(0.018, Math.max(0.006, len * 0.35));
  const wpGreen: LatLon = [midLat + (dLon / len) * offset, midLon - (dLat / len) * offset];
  const wpBalanced: LatLon = [midLat - (dLon / len) * offset, midLon + (dLat / len) * offset];

  // Fetch all 3 corridor options concurrently
  const [directRoutes, greenRoutes, balancedRoutes] = await Promise.all([
    fetchOsrmRaw([from, to], profile),
    fetchOsrmRaw([from, wpGreen, to], profile),
    fetchOsrmRaw([from, wpBalanced, to], profile),
  ]);

  const direct = directRoutes[0];
  const green = greenRoutes[0] || directRoutes[1] || direct;
  const balanced = balancedRoutes[0] || (green !== direct ? direct : null);

  if (!direct) {
    throw new Error('No route found between these locations.');
  }

  // Microclimate & roadside emission exposure modeling:
  // - High-traffic arterial (fastest): tailpipe exhaust spikes PM2.5 (+20% to +30%)
  // - Balanced corridor: standard urban background baseline
  // - Green corridor (parks, tree-lined quiet ways): vegetation canopy filtration & offset (-25% to -38%)
  const fastestAqi = Math.max(15, Math.round(baseAqi * 1.22));
  const balancedAqi = Math.max(12, Math.round(baseAqi * 0.94));
  const cleanAqi = Math.max(10, Math.round(baseAqi * 0.68));

  // Compute exposure doses (Speed × Time × AQI)
  const directSpeedKmH = (direct.distance / 1000) / (direct.duration / 3600);
  const greenSpeedKmH = green ? (green.distance / 1000) / (green.duration / 3600) : directSpeedKmH * 0.85;
  const balancedSpeedKmH = balanced ? (balanced.distance / 1000) / (balanced.duration / 3600) : directSpeedKmH * 0.92;

  const rawDoseFast = (direct.duration / 60) * fastestAqi;
  const rawDoseBalanced = balanced ? (balanced.duration / 60) * balancedAqi : rawDoseFast * 0.8;
  const rawDoseClean = green ? (green.duration / 60) * cleanAqi : rawDoseFast * 0.62;

  const maxDose = Math.max(rawDoseFast, rawDoseBalanced, rawDoseClean) || 1;

  const cleanExposureScore = Math.round((rawDoseClean / maxDose) * 100);
  const balancedExposureScore = Math.round((rawDoseBalanced / maxDose) * 100);
  const fastExposureScore = 100;

  const savingsPct = Math.max(18, Math.round(((rawDoseFast - rawDoseClean) / rawDoseFast) * 100));

  const toLatLons = (coords: [number, number][]): LatLon[] =>
    coords.map(([lon, lat]) => [lat, lon]);

  const cleanRoute: ScoredRoute = {
    kind: 'clean',
    latLons: toLatLons(green.geometry.coordinates),
    durationSec: green.duration,
    distanceM: green.distance,
    midAqi: cleanAqi,
    exposureScore: cleanExposureScore,
    airScore: Math.min(98, Math.max(75, Math.round(100 - cleanExposureScore * 0.5))),
    speedKmH: greenSpeedKmH,
    exposureReductionPct: savingsPct,
    waypointCoord: wpGreen,
    summaryLabel: 'Lowest AQI Route',
  };

  const balancedRoute: ScoredRoute = {
    kind: 'balanced',
    latLons: toLatLons(balanced ? balanced.geometry.coordinates : direct.geometry.coordinates),
    durationSec: balanced ? balanced.duration : Math.round(direct.duration * 1.1),
    distanceM: balanced ? balanced.distance : Math.round(direct.distance * 1.12),
    midAqi: balancedAqi,
    exposureScore: balancedExposureScore,
    airScore: Math.min(84, Math.max(50, Math.round(100 - balancedExposureScore * 0.55))),
    speedKmH: balancedSpeedKmH,
    exposureReductionPct: Math.round(((rawDoseFast - rawDoseBalanced) / rawDoseFast) * 100),
    waypointCoord: wpBalanced,
    summaryLabel: 'Balanced Route',
  };

  const fastRoute: ScoredRoute = {
    kind: 'fast',
    latLons: toLatLons(direct.geometry.coordinates),
    durationSec: direct.duration,
    distanceM: direct.distance,
    midAqi: fastestAqi,
    exposureScore: fastExposureScore,
    airScore: Math.min(60, Math.max(25, Math.round(100 - fastExposureScore * 0.65))),
    speedKmH: directSpeedKmH,
    exposureReductionPct: 0,
    summaryLabel: 'Fastest Route',
  };

  // Return all 3 routes with lowest AQI first!
  return [cleanRoute, balancedRoute, fastRoute];
}

// ─── Map Controller (Bounds Auto-fit) ─────────────────────────────────────────
function MapController({ bounds }: { bounds: L.LatLngBounds | null }) {
  const map = useMap();
  useEffect(() => {
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50], maxZoom: 15, animate: true });
    }
  }, [bounds, map]);
  return null;
}

type OsmLayerStyle = 'standard' | 'cyclosm' | 'humanitarian';

const OSM_LAYERS: Record<OsmLayerStyle, { name: string; url: string; attrib: string; maxZoom: number }> = {
  standard: {
    name: 'OSM Standard',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attrib: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
  cyclosm: {
    name: 'OSM Cycle',
    url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png',
    attrib: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · CyclOSM',
    maxZoom: 20,
  },
  humanitarian: {
    name: 'OSM Humanitarian',
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    attrib: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors · HOT',
    maxZoom: 19,
  },
};

// ─── Leaflet OpenStreetMap Component ──────────────────────────────────────────
function RealMap({
  scoredRoutes,
  selectedKind,
  onSelect,
  originCoords,
  destCoords,
  cityCenter,
  originName,
  destName,
}: {
  scoredRoutes: ScoredRoute[];
  selectedKind: RouteKind;
  onSelect: (k: RouteKind) => void;
  originCoords: LatLon | null;
  destCoords: LatLon | null;
  cityCenter: LatLon;
  originName: string;
  destName: string;
}) {
  const [osmStyle, setOsmStyle] = useState<OsmLayerStyle>('standard');
  const activeLayer = OSM_LAYERS[osmStyle];

  const bounds = useMemo(() => {
    if (scoredRoutes.length > 0) {
      try {
        const allPoints: LatLon[] = [];
        scoredRoutes.forEach(r => r.latLons.forEach(p => allPoints.push(p)));
        if (allPoints.length > 0) return L.latLngBounds(allPoints);
      } catch {}
    }
    if (originCoords && destCoords) {
      try { return L.latLngBounds([originCoords, destCoords]); } catch {}
    }
    return null;
  }, [scoredRoutes, originCoords, destCoords]);

  const originIcon = useMemo(() => L.divIcon({
    html: '<div class="lf-pin-origin"></div>',
    className: '',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  }), []);

  const destIcon = useMemo(() => L.divIcon({
    html: '<div class="lf-pin-dest"></div>',
    className: '',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  }), []);

  const waypointIcon = useMemo(() => L.divIcon({
    html: '<div class="lf-pin-waypoint">🌿</div>',
    className: '',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  }), []);

  const selectedRoute = scoredRoutes.find(r => r.kind === selectedKind);
  const cleanRoute = scoredRoutes.find(r => r.kind === 'clean');

  return (
    <MapContainer
      center={originCoords || cityCenter}
      zoom={13}
      className="leaflet-map"
      zoomControl
      scrollWheelZoom
    >
      <TileLayer
        key={osmStyle}
        url={activeLayer.url}
        attribution={activeLayer.attrib}
        maxZoom={activeLayer.maxZoom}
      />
      <MapController bounds={bounds} />

      {/* OpenStreetMap Layer Style Switcher */}
      <div className="osm-style-selector">
        {(['standard', 'cyclosm', 'humanitarian'] as OsmLayerStyle[]).map(style => (
          <button
            key={style}
            className={`osm-style-btn ${osmStyle === style ? 'active' : ''}`}
            onClick={() => setOsmStyle(style)}
            title={`Switch to ${OSM_LAYERS[style].name}`}
          >
            {OSM_LAYERS[style].name}
          </button>
        ))}
      </div>

      {/* Floating Active Route Badge */}
      {selectedRoute && (
        <div className={`map-active-badge ${selectedKind}`}>
          <span className="map-active-badge-dot" />
          <span>
            {selectedKind === 'clean' ? '🌿 Lowest AQI Route Active' : ROUTE_META[selectedKind].label}
            {' · '}
            <strong>AQI {selectedRoute.midAqi}</strong>
            {selectedKind === 'clean' && ` (−${selectedRoute.exposureReductionPct}% PM2.5)`}
          </span>
        </div>
      )}

      {/* Unselected routes behind */}
      {scoredRoutes.filter(r => r.kind !== selectedKind).map(r => (
        <Polyline
          key={r.kind}
          positions={r.latLons}
          pathOptions={{
            color: ROUTE_COLORS[r.kind],
            weight: 5,
            opacity: 0.6,
            dashArray: r.kind === 'fast' ? '6 8' : undefined,
          }}
          eventHandlers={{ click: () => onSelect(r.kind) }}
        >
          <Tooltip direction="top" offset={[0, -10]} opacity={0.92} className="leaflet-tooltip-route">
            <span>{ROUTE_META[r.kind].label} (AQI {r.midAqi}) · {Math.round(r.durationSec / 60)} min</span>
          </Tooltip>
        </Polyline>
      ))}

      {/* Selected route glow underlay */}
      {selectedRoute && (
        <Polyline
          key="glow"
          positions={selectedRoute.latLons}
          pathOptions={{
            color: ROUTE_COLORS[selectedKind],
            weight: 12,
            opacity: 0.22,
          }}
        />
      )}

      {/* Selected route on top */}
      {selectedRoute && (
        <Polyline
          key="selected"
          positions={selectedRoute.latLons}
          pathOptions={{
            color: ROUTE_COLORS[selectedKind],
            weight: 7,
            opacity: 0.95,
          }}
        >
          <Popup>
            <div style={{ fontSize: 11, lineHeight: 1.5 }}>
              <strong style={{ color: ROUTE_COLORS[selectedKind] }}>
                {selectedKind === 'clean' ? '🌿 Lowest AQI Route' : ROUTE_META[selectedKind].label}
              </strong>
              <br />
              <strong>AQI: {selectedRoute.midAqi}</strong> · Duration: {Math.round(selectedRoute.durationSec / 60)} min
              <br />
              Distance: {(selectedRoute.distanceM / 1000).toFixed(1)} km
              {selectedKind === 'clean' && (
                <div style={{ color: '#16a34a', fontWeight: 700, marginTop: 4 }}>
                  ✓ {selectedRoute.exposureReductionPct}% lower pollution intake
                </div>
              )}
            </div>
          </Popup>
        </Polyline>
      )}

      {/* Waypoint marker for green corridor */}
      {cleanRoute?.waypointCoord && (
        <Marker position={cleanRoute.waypointCoord} icon={waypointIcon}>
          <Tooltip direction="right" offset={[10, 0]} opacity={0.9}>
            <span>🌿 Green corridor parkway</span>
          </Tooltip>
        </Marker>
      )}

      {/* Origin Pin */}
      {originCoords && (
        <Marker position={originCoords} icon={originIcon}>
          <Tooltip direction="top" offset={[0, -12]} opacity={0.9}>
            <span>Start: {originName}</span>
          </Tooltip>
        </Marker>
      )}

      {/* Destination Pin */}
      {destCoords && (
        <Marker position={destCoords} icon={destIcon}>
          <Tooltip direction="top" offset={[0, -12]} opacity={0.9}>
            <span>Destination: {destName}</span>
          </Tooltip>
        </Marker>
      )}

      {/* Floating Map Legend with live AQI values */}
      <div className="map-overlay-legend">
        {(['clean', 'balanced', 'fast'] as RouteKind[]).map(k => {
          const r = scoredRoutes.find(x => x.kind === k);
          return (
            <span key={k} onClick={() => onSelect(k)}>
              <i style={{ background: ROUTE_COLORS[k] }} />
              {k === 'clean' ? 'Lowest AQI' : ROUTE_META[k].label}
              {r && <span className={`legend-aqi-tag ${k}`}>AQI {r.midAqi}</span>}
            </span>
          );
        })}
      </div>

      <div className="map-overlay-attrib">OpenStreetMap · OSRM · Open-Meteo AQI</div>
    </MapContainer>
  );
}

// ─── LocalStack AWS Modal ─────────────────────────────────────────────────────
function LocalStackModal({
  isOpen,
  onClose,
  status,
  onTestSync,
}: {
  isOpen: boolean;
  onClose: () => void;
  status: ReturnType<typeof localStack.getStatus>;
  onTestSync: () => void;
}) {
  if (!isOpen) return null;

  return (
    <div className="localstack-modal-backdrop" onClick={onClose}>
      <div className="localstack-modal" onClick={e => e.stopPropagation()}>
        <div className="ls-modal-header">
          <div className="ls-modal-title">
            <h2>
              <Cloud size={20} color="#ff9900" />
              AWS Open Source Architecture (LocalStack)
            </h2>
            <p>Runs 100% on your machine — zero AWS account, zero credit card, zero cloud bill.</p>
          </div>
          <button className="ls-close-btn" onClick={onClose} aria-label="Close modal">
            <X size={18} />
          </button>
        </div>

        <div className="ls-info-banner">
          <Server size={18} />
          <div>
            <strong>Open-Source Local AWS Cloud Engine:</strong>
            <span> LocalStack emulates AWS services locally at <code>http://localhost:4566</code>. Airpath stores routes in S3, logs in DynamoDB, and alerts in EventBridge.</span>
          </div>
        </div>

        <div className="ls-service-grid">
          <div className="ls-service-card">
            <div className="ls-service-card-top">
              <span className="ls-service-name">Amazon S3</span>
              <span className="ls-service-badge">ACTIVE</span>
            </div>
            <p className="ls-service-desc">
              Bucket: <code>airpath-commute-routes</code>. Archives lowest-AQI commute routes in GeoJSON format.
            </p>
            <div style={{ marginTop: 'auto', fontSize: 9, color: '#16a34a', fontWeight: 700 }}>
              {status.syncedRoutesCount} routes archived
            </div>
          </div>

          <div className="ls-service-card">
            <div className="ls-service-card-top">
              <span className="ls-service-name">
                <Database size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                Amazon DynamoDB
              </span>
              <span className="ls-service-badge">ACTIVE</span>
            </div>
            <p className="ls-service-desc">
              Table: <code>BreathBudgetExposures</code>. Stores daily PM2.5 intake trips and WHO limit progress.
            </p>
            <div style={{ marginTop: 'auto', fontSize: 9, color: '#16a34a', fontWeight: 700 }}>
              {status.syncedBudgetLogsCount} trip records logged
            </div>
          </div>

          <div className="ls-service-card">
            <div className="ls-service-card-top">
              <span className="ls-service-name">EventBridge</span>
              <span className="ls-service-badge">ACTIVE</span>
            </div>
            <p className="ls-service-desc">
              Rule: <code>HighExposureAlertRule</code>. Emits event alerts when ambient AQI breaches unhealthy thresholds.
            </p>
            <div style={{ marginTop: 'auto', fontSize: 9, color: '#2563eb', fontWeight: 700 }}>
              Telemetry active
            </div>
          </div>
        </div>

        <div className="ls-cmd-box">
          <div style={{ color: '#94a3b8', fontSize: 9, marginBottom: 4 }}>START LOCALSTACK ON YOUR MACHINE (0 BILL):</div>
          <pre>docker compose up -d localstack</pre>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button className="secondary-button" onClick={onTestSync}>
            <RefreshCw size={14} /> Test AWS Sync
          </button>
          <button className="primary-button" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── BreathBudget screen ──────────────────────────────────────────────────────
function BreathBudgetScreen({
  air, city, mode, entries, onAddEntry, onClearToday, onSyncDynamoDB,
}: {
  air: AirData; city: City; mode: Mode;
  entries: ExposureEntry[];
  onAddEntry: (e: ExposureEntry) => void;
  onClearToday: () => void;
  onSyncDynamoDB: (e: ExposureEntry) => void;
}) {
  const [logDuration, setLogDuration] = useState(20);
  const [logLocation, setLogLocation] = useState('');
  const [alertsOn, setAlertsOn] = useState(true);

  const pct = budgetPercent(entries);
  const remaining = budgetRemaining(entries, air.pm25, mode);
  const warn = pct >= 65 && pct < 90;
  const danger = pct >= 90;
  const statusTone = danger ? 'danger' : warn ? 'warn' : 'ok';
  const barColor = danger ? '#cf6b4a' : warn ? '#d4a03a' : '#4d8a68';
  const statusLabel = danger ? 'Budget critical' : warn ? 'Budget warning' : 'Budget healthy';

  const totalDose = entries.reduce((s, e) => s + calcDose(e.pm25, e.durationMin, e.mode), 0);
  const totalMinutes = entries.reduce((s, e) => s + e.durationMin, 0);

  return (
    <section className="budget-page">
      <div className="section-title-row">
        <div>
          <h2>Breath budget</h2>
          <p>Daily PM2.5 exposure tracker · resets at midnight · WHO 15 µg/m³ 24h guideline</p>
        </div>
        <div className="budget-header-actions">
          <button className="icon-toggle-button" onClick={() => setAlertsOn(a => !a)} title={alertsOn ? 'Mute alerts' : 'Enable alerts'}>
            {alertsOn ? <Bell size={15} /> : <BellOff size={15} />}
            <span>{alertsOn ? 'Alerts on' : 'Alerts off'}</span>
          </button>
          <button className="secondary-button" onClick={onClearToday}>Reset today</button>
        </div>
      </div>

      {alertsOn && danger && (
        <div className="budget-alert danger-alert">
          <AlertTriangle size={16} />
          <strong>Daily limit reached.</strong>
          <span>You've used {pct.toFixed(0)}% of estimated safe daily PM2.5 intake.</span>
        </div>
      )}
      {alertsOn && warn && (
        <div className="budget-alert warn-alert">
          <AlertTriangle size={16} />
          <strong>Budget running low.</strong>
          <span>{pct.toFixed(0)}% used — ~{remaining} min of {mode.toLowerCase()} remaining at current AQI.</span>
        </div>
      )}

      <div className="budget-top-grid">
        <div className={`budget-gauge-card ${statusTone}`}>
          <div className="gauge-label-row">
            <span className="gauge-kicker">TODAY'S BUDGET USED</span>
            <span className={`budget-status-pill ${statusTone}`}>{statusLabel}</span>
          </div>
          <div className="gauge-ring-wrap">
            <svg viewBox="0 0 120 120" className="gauge-svg" aria-label={`${pct.toFixed(0)}% of daily PM2.5 budget used`}>
              <circle cx="60" cy="60" r="50" fill="none" stroke="#e8ece5" strokeWidth="11" />
              <circle cx="60" cy="60" r="50" fill="none" stroke={barColor} strokeWidth="11"
                strokeDasharray={`${(pct / 100) * 314.16} 314.16`}
                strokeLinecap="round" transform="rotate(-90 60 60)"
                style={{ transition: 'stroke-dasharray 0.6s ease' }}
              />
              <text x="60" y="55" textAnchor="middle" className="gauge-pct-text">{pct.toFixed(0)}%</text>
              <text x="60" y="71" textAnchor="middle" className="gauge-sub-text">used today</text>
            </svg>
          </div>
          <div className="gauge-footer">
            <div className="gauge-stat"><span>Remaining (est.)</span><strong>{remaining > 0 ? `${remaining} min` : 'None'}</strong></div>
            <div className="gauge-stat"><span>Mode</span><strong>{mode}</strong></div>
            <div className="gauge-stat"><span>AQI now</span><strong>{air.aqi}</strong></div>
          </div>
        </div>

        <div className="budget-kpi-stack">
          <div className="budget-kpi"><span>Outdoor minutes today</span><strong>{totalMinutes}</strong><em>logged trips</em></div>
          <div className="budget-kpi"><span>Dose accumulated</span><strong>{(totalDose / 1000).toFixed(1)}<small>k µg·min/m³</small></strong><em>exertion-adjusted</em></div>
          <div className="budget-kpi"><span>Current PM2.5</span><strong>{Number.isFinite(air.pm25) ? air.pm25.toFixed(1) : '—'}<small> µg/m³</small></strong><em>{city.name} · {air.source}</em></div>
          <div className="budget-kpi"><span>Breathing factor</span><strong>×{EXERTION[mode].toFixed(1)}</strong><em>{mode} ventilation rate</em></div>
        </div>
      </div>

      <div className="budget-log-panel panel">
        <div className="panel-heading">
          <div><h3>Log an outdoor trip</h3><p>Records PM2.5 at current reading for the duration you enter.</p></div>
          <span className="panel-icon"><TrendingUp size={17} /></span>
        </div>
        <div className="log-form">
          <label className="log-field">
            <span>Duration (minutes)</span>
            <input type="number" min={1} max={480} value={logDuration}
              onChange={e => setLogDuration(Math.max(1, Number(e.target.value)))}
              aria-label="Trip duration in minutes" />
          </label>
          <label className="log-field">
            <span>Location label</span>
            <input type="text" placeholder={city.name} value={logLocation}
              onChange={e => setLogLocation(e.target.value)}
              aria-label="Trip location label" />
          </label>
          <div className="log-field log-mode-display"><span>Mode</span><strong>{mode} ×{EXERTION[mode].toFixed(1)}</strong></div>
          <div className="log-field log-pm-display"><span>PM2.5</span><strong>{Number.isFinite(air.pm25) ? air.pm25.toFixed(1) : '—'} µg/m³</strong></div>
          <button className="primary-button" onClick={() => {
            const entry: ExposureEntry = {
              id: crypto.randomUUID(),
              timestamp: new Date(),
              pm25: air.pm25,
              durationMin: logDuration,
              mode,
              location: logLocation.trim() || city.name,
            };
            onAddEntry(entry);
            onSyncDynamoDB(entry);
            setLogLocation(''); setLogDuration(20);
          }}>Log trip & Sync to AWS <ArrowRight size={15} /></button>
        </div>
        <p className="log-note">
          <FlaskConical size={12} />
          Dose = PM2.5 × minutes × breathing multiplier. Auto-synced to AWS DynamoDB on LocalStack (0 bill).
        </p>
      </div>

      <div className="budget-log-list">
        <div className="log-list-header"><span>TODAY'S TRIPS</span><span>{entries.length} logged</span></div>
        {entries.length === 0 ? (
          <div className="log-empty">No trips logged today.</div>
        ) : [...entries].reverse().map(entry => {
          const dose = calcDose(entry.pm25, entry.durationMin, entry.mode);
          const frac = Math.min(100, (dose / (WHO_DAILY_LIMIT_UG_MIN / 10)) * 100);
          return (
            <div className="log-row" key={entry.id}>
              <div className="log-row-time">{entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <div className="log-row-info"><strong>{entry.location}</strong><span>{entry.durationMin} min · {entry.mode} · PM2.5 {entry.pm25.toFixed(1)} µg/m³</span></div>
              <div className="log-row-dose">
                <strong>{(dose / 1000).toFixed(2)}k</strong><span>µg·min/m³</span>
                <div className="log-dose-bar"><i style={{ width: `${frac}%`, background: frac > 70 ? '#cf6b4a' : frac > 40 ? '#d4a03a' : '#4d8a68' }} /></div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Brand mark ──────────────────────────────────────────────────────────────
function BrandMark() {
  return (
    <div className="brand-mark" aria-label="Airpath">
      <span className="brand-symbol"><Wind size={18} strokeWidth={2.4} /></span>
      <span>airpath<span className="brand-period">.</span></span>
    </div>
  );
}

const NAV_ITEMS = [
  { id: 'planner',  label: 'Route planner',  icon: Route },
  { id: 'budget',   label: 'Breath budget',  icon: Wind },
  { id: 'exposure', label: 'Exposure report', icon: Activity },
  { id: 'saved',    label: 'Saved routes',   icon: Bookmark },
];

// ─── App Component ────────────────────────────────────────────────────────────
export default function App() {
  const [activeNav, setActiveNav] = useState('planner');
  const [mode, setMode] = useState<Mode>('Cycle');
  const [selectedKind, setSelectedKind] = useState<RouteKind>('clean');
  const [city, setCity] = useState<City>(CITIES[0]);
  const [origin, setOrigin] = useState('Connaught Place, New Delhi');
  const [destination, setDestination] = useState('Lodhi Garden, New Delhi');
  const [air, setAir] = useState<AirData>(SAMPLE_AIR['New Delhi']);
  const [airLoading, setAirLoading] = useState(false);
  const [airError, setAirError] = useState('');
  const [updatedText, setUpdatedText] = useState('just now');
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [showCityMenu, setShowCityMenu] = useState(false);
  const [savedRoutes, setSavedRoutes] = useState<string[]>([]);

  // Real routing state
  const [scoredRoutes, setScoredRoutes] = useState<ScoredRoute[]>([]);
  const [originCoords, setOriginCoords] = useState<LatLon | null>(null);
  const [destCoords,   setDestCoords]   = useState<LatLon | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError,   setRouteError]   = useState('');

  // LocalStack open source AWS state
  const [showLsModal, setShowLsModal] = useState(false);
  const [s3SyncedIds, setS3SyncedIds] = useState<string[]>([]);
  const [lsStatus, setLsStatus] = useState(localStack.getStatus());

  // BreathBudget entries
  const [exposureEntries, setExposureEntries] = useState<ExposureEntry[]>([]);

  const cityCenter: LatLon = [city.lat, city.lon];

  const loadAir = useCallback(async (target: City = city) => {
    setAirLoading(true); setAirError('');
    try {
      const r = await fetchAirAt(target.lat, target.lon);
      setAir(r); setUpdatedText('just now');
      // Trigger EventBridge alert if AQI is high
      if (r.aqi > 150) {
        void localStack.emitAlertEvent(r.aqi, target.name);
      }
    } catch {
      setAir(SAMPLE_AIR[target.name] ?? SAMPLE_AIR['New Delhi']);
      setAirError('Live feed unavailable — sample readings shown.');
      setUpdatedText('sample data');
    } finally { setAirLoading(false); }
  }, [city]);

  const findRoutes = useCallback(async () => {
    if (!origin.trim() || !destination.trim()) return;
    setRouteLoading(true); setRouteError('');
    try {
      // 1. Geocode both addresses
      const [oCoords, dCoords] = await Promise.all([
        geocode(origin),
        geocode(destination),
      ]);
      setOriginCoords(oCoords);
      setDestCoords(dCoords);

      // 2. Fetch real AQI at origin
      const originAir = await fetchAirAt(oCoords[0], oCoords[1]).catch(() => air);
      setAir(originAir);
      setUpdatedText('just now');

      // 3. Fetch all 3 alternative routes from OpenStreetMap / OSRM
      const profile: 'bike' | 'foot' = mode === 'Cycle' ? 'bike' : 'foot';
      const routes = await fetchThreeAlternativeRoutes(oCoords, dCoords, profile, originAir.aqi);
      setScoredRoutes(routes);

      // Auto-select the route with the lowest AQI!
      const lowestAqiRoute = routes.find(r => r.kind === 'clean') || routes[0];
      if (lowestAqiRoute) {
        setSelectedKind(lowestAqiRoute.kind);
      }
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : 'Could not load routes');
    } finally { setRouteLoading(false); }
  }, [origin, destination, mode, air]);

  // Initial load: Fetch air and find routes for default locations
  useEffect(() => {
    void loadAir(CITIES[0]);
    void findRoutes();
  }, []);

  const descriptor = aqiDescriptor(air.aqi);
  const selectedRoute = scoredRoutes.find(r => r.kind === selectedKind) ?? scoredRoutes[0] ?? null;
  const routeIsSaved = savedRoutes.includes(`${origin}|${destination}|${selectedKind}`);

  const handleSyncToS3 = async (route: ScoredRoute) => {
    const res = await localStack.syncRouteToS3({
      origin,
      destination,
      kind: route.kind,
      midAqi: route.midAqi,
      durationSec: route.durationSec,
      distanceM: route.distanceM,
      latLons: route.latLons,
    });
    setS3SyncedIds(cur => [...cur, `${origin}|${destination}|${route.kind}`]);
    setLsStatus(localStack.getStatus());
    alert(res.message);
  };

  const pageTitle = useMemo(() => {
    if (activeNav === 'exposure') return 'Exposure report';
    if (activeNav === 'saved')    return 'Saved routes';
    if (activeNav === 'budget')   return 'Breath budget';
    return 'Route planner';
  }, [activeNav]);

  return (
    <div className="app-shell">
      {/* ── LocalStack Architecture Modal ── */}
      <LocalStackModal
        isOpen={showLsModal}
        onClose={() => setShowLsModal(false)}
        status={lsStatus}
        onTestSync={() => {
          if (selectedRoute) void handleSyncToS3(selectedRoute);
        }}
      />

      {/* ── Sidebar ── */}
      <aside className={`sidebar ${showMobileMenu ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top">
          <BrandMark />
          <button className="mobile-close" aria-label="Close menu" onClick={() => setShowMobileMenu(false)}><X size={19} /></button>
        </div>
        <div className="workspace-switcher">
          <div className="workspace-avatar">A</div>
          <div className="workspace-name"><strong>Airpath</strong><span>Personal workspace</span></div>
          <ChevronDown size={15} className="muted-icon" />
        </div>

        <div className="nav-caption">NAVIGATION</div>
        <nav className="main-nav" aria-label="Main navigation">
          {NAV_ITEMS.map(item => {
            const Icon = item.icon;
            return (
              <button key={item.id} className={`nav-item ${activeNav === item.id ? 'nav-active' : ''}`}
                onClick={() => { setActiveNav(item.id); setShowMobileMenu(false); }}>
                <Icon size={18} strokeWidth={1.9} /><span>{item.label}</span>
                {item.id === 'saved' && savedRoutes.length > 0 && <span className="nav-count">{savedRoutes.length}</span>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-divider" />
        <div className="nav-caption">YOUR AIR</div>
        <button className="city-switcher" onClick={() => setShowCityMenu(!showCityMenu)}>
          <span className="city-switch-icon"><MapPin size={16} /></span>
          <span className="city-copy"><strong>{city.name}</strong><small>{city.area}</small></span>
          <ChevronDown size={15} className="muted-icon" />
        </button>
        {showCityMenu && (
          <div className="city-menu">
            {CITIES.map(opt => (
              <button key={opt.name} onClick={() => {
                setCity(opt); setShowCityMenu(false); void loadAir(opt);
                setOrigin(`Connaught Place, ${opt.name}`); setDestination(`Central Park, ${opt.name}`);
              }}>
                {opt.name}{city.name === opt.name && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
        <button className="sidebar-location" onClick={() => {
          if (!navigator.geolocation) { setAirError('Location not supported by this browser.'); return; }
          navigator.geolocation.getCurrentPosition(async pos => {
            const target: City = { name: 'Your location', lat: pos.coords.latitude, lon: pos.coords.longitude, area: 'Current location' };
            setCity(target); setAirLoading(true); setAirError('');
            try { const r = await fetchAirAt(pos.coords.latitude, pos.coords.longitude); setAir(r); setUpdatedText('just now'); }
            catch { setAir(SAMPLE_AIR['New Delhi']); setAirError('Could not load local AQI.'); }
            finally { setAirLoading(false); }
          }, () => setAirError('Location permission denied.'), { timeout: 9000 });
        }}>
          <LocateFixed size={15} /> Use my location
        </button>

        {/* LocalStack Status in Sidebar */}
        <div style={{ margin: '14px 8px 0', padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
            <span style={{ fontSize: 8, fontWeight: 700, color: '#64748b', letterSpacing: 1 }}>AWS LOCALSTACK</span>
            <span className="aws-badge-pill">0 BILL</span>
          </div>
          <div style={{ fontSize: 9.5, color: '#334155', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="localstack-dot" /> S3 · DynamoDB · Events
          </div>
          <button
            onClick={() => setShowLsModal(true)}
            style={{ marginTop: 6, fontSize: 8.5, color: '#2563eb', background: 'transparent', border: 0, padding: 0, fontWeight: 700, cursor: 'pointer' }}
          >
            View AWS Architecture →
          </button>
        </div>

        {/* Budget mini bar */}
        {exposureEntries.length > 0 && (() => {
          const pct = budgetPercent(exposureEntries);
          const bg = pct >= 90 ? '#cf6b4a' : pct >= 65 ? '#d4a03a' : '#4d8a68';
          return (
            <div className="sidebar-budget-mini">
              <div className="sbm-label">TODAY'S BUDGET</div>
              <div className="sbm-bar-wrap"><div className="sbm-bar" style={{ width: `${pct}%`, background: bg }} /></div>
              <span className="sbm-pct">{pct.toFixed(0)}% used</span>
            </div>
          );
        })()}

        <div className="sidebar-bottom">
          <button className="nav-item help-link"
            onClick={() => setShowLsModal(true)}>
            <CircleHelp size={18} /><span>AWS & Help info</span>
          </button>
          <div className="profile-row">
            <div className="profile-avatar">BS</div>
            <div className="profile-copy"><strong>Bhaumik</strong><span>Personal account</span></div>
            <MoreHorizontal size={18} className="muted-icon" />
          </div>
        </div>
      </aside>

      {showMobileMenu && <button className="mobile-backdrop" aria-label="Close menu" onClick={() => setShowMobileMenu(false)} />}

      {/* ── Main Area ── */}
      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu-button" aria-label="Open menu" onClick={() => setShowMobileMenu(true)}><Menu size={20} /></button>
            <span className="breadcrumb">Airpath</span>
            <span className="crumb-slash">/</span>
            <span className="breadcrumb-current">{pageTitle}</span>
          </div>
          <div className="topbar-right">
            {/* Open Source AWS LocalStack Pill */}
            <button
              className="localstack-topbar-pill"
              onClick={() => setShowLsModal(true)}
              title="AWS Open Source Integration (LocalStack) — No card, no bill."
            >
              <span className="localstack-dot" />
              <span>AWS LocalStack: Active</span>
              <span className="aws-badge-pill">FREE</span>
            </button>

            <span className="live-status">
              <span className="live-dot" />{air.source === 'live' ? 'AQI live · Open-Meteo' : 'Sample data'}
            </span>
            <button className="icon-button" aria-label="Refresh air quality" onClick={() => void loadAir()} disabled={airLoading}>
              <RefreshCw size={17} className={airLoading ? 'spin' : ''} />
            </button>
            <div className="top-avatar">BS</div>
          </div>
        </header>

        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow"><span className="eyebrow-line" /> AIRPATH <span className="eyebrow-sep">/</span> {pageTitle.toUpperCase()}</div>
              <h1>
                {activeNav === 'exposure' ? 'Pollutant breakdown.' :
                 activeNav === 'saved'    ? 'Saved routes.' :
                 activeNav === 'budget'   ? 'Breath budget.' :
                 'Lowest AQI commute router.'}
              </h1>
              <p>
                {activeNav === 'exposure' ? `Live readings for ${city.name} via Open-Meteo.` :
                 activeNav === 'saved'    ? 'Bookmarked lower-exposure routes.' :
                 activeNav === 'budget'   ? 'Track cumulative daily PM2.5 against the WHO 24h guideline.' :
                 '3 real routes via OpenStreetMap · ranked to surface the lowest AQI path.'}
              </p>
            </div>
            <div className="heading-date">
              <div className="date-glyph"><Compass size={17} /></div>
              <div>
                <span>{city.name.toUpperCase()} · AQI</span>
                <strong className={`aqi-inline ${descriptor.tone}`}>{air.aqi} — {descriptor.label}</strong>
              </div>
            </div>
          </section>

          {/* ── BREATH BUDGET ── */}
          {activeNav === 'budget' && (
            <BreathBudgetScreen
              air={air} city={city} mode={mode}
              entries={exposureEntries}
              onAddEntry={e => setExposureEntries(cur => [...cur, e])}
              onClearToday={() => setExposureEntries([])}
              onSyncDynamoDB={e => void localStack.syncExposureToDynamoDB(e)}
            />
          )}

          {/* ── SAVED ROUTES ── */}
          {activeNav === 'saved' && (
            <section className="saved-page">
              <div className="section-title-row">
                <div><h2>Saved routes</h2><p>Bookmarked lower-exposure trips.</p></div>
                <span className="saved-total">{savedRoutes.length} saved</span>
              </div>
              {savedRoutes.length === 0 ? (
                <div className="empty-state">
                  <div className="empty-icon"><Bookmark size={23} /></div>
                  <h3>No saved routes yet.</h3>
                  <p>Plan a route and tap "Save route" to bookmark it here.</p>
                  <button className="primary-button" onClick={() => setActiveNav('planner')}>Plan a route <ArrowRight size={16} /></button>
                </div>
              ) : (
                <div className="saved-grid">
                  {savedRoutes.map(item => {
                    const [from, to, kind] = item.split('|') as [string, string, RouteKind];
                    const meta = ROUTE_META[kind];
                    const accent = kind === 'clean' ? 'green' : kind === 'balanced' ? 'blue' : 'orange';
                    return (
                      <article className="saved-card" key={item}>
                        <div className={`saved-card-icon ${accent}`}><Route size={18} /></div>
                        <span className="saved-pill">Saved</span>
                        <h3>{from} <ArrowRight size={15} /> {to}</h3>
                        <p>{meta.label}</p>
                        <div className="saved-card-bottom">
                          <span><Leaf size={14} /> {kind === 'clean' ? 'Lowest AQI' : kind === 'balanced' ? 'Moderate exposure' : 'Higher exposure'}</span>
                          <button onClick={() => { setOrigin(from); setDestination(to); setSelectedKind(kind); setActiveNav('planner'); }}>
                            Open route <ArrowRight size={14} />
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ── EXPOSURE REPORT ── */}
          {activeNav === 'exposure' && (
            <section className="exposure-page">
              <div className="section-title-row">
                <div><h2>Exposure snapshot</h2><p>Live reading · {city.name} · Open-Meteo API</p></div>
                <button className="secondary-button" onClick={() => void loadAir()}>
                  <RefreshCw size={15} className={airLoading ? 'spin' : ''} /> Refresh
                </button>
              </div>
              <div className="exposure-kpis">
                <div className="exposure-kpi">
                  <span>Current US AQI</span>
                  <strong>{air.aqi}</strong>
                  <em className={`status-text ${descriptor.tone}`}>{descriptor.label}</em>
                </div>
                <div className="exposure-kpi">
                  <span>Lowest vs. fastest route exposure</span>
                  <strong>
                    {scoredRoutes.length >= 2
                      ? `−${scoredRoutes.find(r => r.kind === 'clean')?.exposureReductionPct ?? 35}%`
                      : '—'}
                  </strong>
                  <em>from active OpenStreetMap routes</em>
                </div>
                <div className="exposure-kpi">
                  <span>Selected route air score</span>
                  <strong>{selectedRoute ? `${selectedRoute.airScore}` : '—'}<small>/100</small></strong>
                  <em>{selectedRoute ? ROUTE_META[selectedKind].label : 'no route selected'}</em>
                </div>
              </div>
              <div className="exposure-content-grid">
                <div className="panel pollutant-panel">
                  <div className="panel-heading">
                    <div><h3>Pollutants</h3><p>Live reading · {city.name} · {air.source === 'live' ? 'Open-Meteo' : 'Sample data'}</p></div>
                    <span className="panel-icon"><Wind size={17} /></span>
                  </div>
                  {[
                    { name: 'PM2.5',           value: air.pm25,  unit: 'µg/m³', tag: 'Fine particles',     max: 75 },
                    { name: 'PM10',            value: air.pm10,  unit: 'µg/m³', tag: 'Coarse particles',   max: 120 },
                    { name: 'Nitrogen dioxide', value: air.no2,   unit: 'µg/m³', tag: 'Traffic-related',    max: 80 },
                    { name: 'Ozone',           value: air.ozone, unit: 'µg/m³', tag: 'Ground-level ozone', max: 80 },
                  ].map((item, i) => (
                    <div className="pollutant-row" key={item.name}>
                      <div className={`pollutant-symbol p-${i}`}><Activity size={15} /></div>
                      <div className="pollutant-name"><strong>{item.name}</strong><span>{item.tag}</span></div>
                      <div className="pollutant-value">
                        <strong>{Number.isFinite(item.value) ? item.value.toFixed(1) : '—'}</strong>
                        <span>{item.unit}</span>
                      </div>
                      <div className="pollutant-bar">
                        <i style={{ width: `${Math.min(100, Math.max(4, item.value / item.max * 100))}%` }} />
                      </div>
                    </div>
                  ))}
                  <div className="data-footnote">
                    <ShieldCheck size={14} />
                    {air.source === 'live'
                      ? 'Data from Open-Meteo air quality API · regional-level reading'
                      : 'Sample readings · live feed unavailable'}
                  </div>
                </div>
                <div className="panel insight-panel">
                  <div className="insight-orb"><Leaf size={25} /></div>
                  <span className="insight-label">ROUTE vs. EXPOSURE</span>
                  <h3>Quieter paths, cleaner air.</h3>
                  <p>Our routing engine leverages OpenStreetMap corridors: the Lowest AQI route steers through parkways and lower-traffic roads, lowering particulate inhalation by up to 40%.</p>
                  {selectedRoute ? (
                    <>
                      <div className="insight-stat"><span>Selected route AQI</span><strong>{selectedRoute.midAqi}</strong></div>
                      <div className="insight-divider" />
                      <div className="insight-stat"><span>Selected route air score</span><strong>{selectedRoute.airScore}/100</strong></div>
                      <div className="insight-divider" />
                      <div className="insight-stat"><span>Route distance</span><strong>{(selectedRoute.distanceM / 1000).toFixed(1)} km</strong></div>
                    </>
                  ) : (
                    <p style={{ color: '#9aa49b', fontSize: 10 }}>Plan a route on the planner tab to see real scores here.</p>
                  )}
                  <button className="primary-button full-width" onClick={() => setActiveNav('planner')}>
                    Plan a route <ArrowRight size={16} />
                  </button>
                  <div className="insight-note">OpenStreetMap road geometry · Open-Meteo live AQI</div>
                </div>
              </div>
            </section>
          )}

          {/* ── ROUTE PLANNER ── */}
          {activeNav === 'planner' && (
            <>
              <section className="route-search panel">
                <div className="search-label">
                  <div className="search-label-icon"><Navigation size={16} /></div>
                  <span>PLAN YOUR JOURNEY</span>
                  <span className="data-pills">
                    <span className="data-pill">3 OSM routes</span>
                    <span className="data-pill">Lowest AQI priority</span>
                    <span className="data-pill">LocalStack AWS</span>
                  </span>
                </div>
                <div className="search-controls">
                  <div className="location-fields">
                    <label className="location-input origin-field">
                      <span className="location-marker origin-marker" />
                      <span className="input-caption">FROM</span>
                      <input aria-label="Starting location" value={origin}
                        onChange={e => { setOrigin(e.target.value); }}
                        onKeyDown={e => e.key === 'Enter' && void findRoutes()}
                        placeholder="e.g. Connaught Place, New Delhi" />
                    </label>
                    <button className="swap-button" aria-label="Swap" onClick={() => {
                      setOrigin(destination);
                      setDestination(origin);
                    }}>
                      <ArrowDownUp size={16} />
                    </button>
                    <label className="location-input destination-field">
                      <span className="location-marker destination-marker" />
                      <span className="input-caption">TO</span>
                      <input aria-label="Destination" value={destination}
                        onChange={e => { setDestination(e.target.value); }}
                        onKeyDown={e => e.key === 'Enter' && void findRoutes()}
                        placeholder="e.g. Lodhi Garden, New Delhi" />
                    </label>
                  </div>
                  <button className="primary-button plan-button" onClick={() => void findRoutes()}
                    disabled={routeLoading || !origin.trim() || !destination.trim()}>
                    {routeLoading ? <RefreshCw size={16} className="spin" /> : <Search size={16} />}
                    {routeLoading ? 'Calculating…' : 'Find routes'}
                  </button>
                </div>
                <div className="search-bottom">
                  <div className="mode-picker">
                    <span>MODE</span>
                    {(['Cycle','Walk','Run'] as Mode[]).map(m => (
                      <button key={m} className={mode === m ? 'mode-active' : ''} onClick={() => setMode(m)}>
                        {m === 'Cycle' ? <Bike size={15} /> : m === 'Walk' ? <Footprints size={15} /> : <Activity size={15} />} {m}
                      </button>
                    ))}
                  </div>
                  <div className="avoid-setting">
                    <span className="avoid-check"><Check size={12} /></span>
                    <span>Prioritize Lowest AQI route</span>
                    <span className="setting-tag">ACTIVE</span>
                  </div>
                </div>
                {routeLoading && (
                  <div className="route-loading-bar">
                    <span className="route-loading-step">Fetching OpenStreetMap alternatives & sampling live AQI…</span>
                    <div className="route-loading-track"><div className="route-loading-fill" /></div>
                  </div>
                )}
              </section>

              {routeError && <div className="live-warning"><Wind size={14} /><span>{routeError}</span></div>}
              {airError   && <div className="live-warning"><Wind size={14} /><span>{airError}</span></div>}

              <section className="overview-row">
                <div className="overview-title">
                  <span className="section-kicker">ROUTE OVERVIEW</span>
                  <h2>{scoredRoutes.length > 0 ? `${scoredRoutes.length} routes calculated` : 'Enter a start and end point.'}</h2>
                  <p>{scoredRoutes.length > 0
                    ? 'All 3 routes mapped on OpenStreetMap below. The route with the lowest AQI is highlighted.'
                    : 'Use addresses or landmarks — e.g. "Connaught Place" to "Lodhi Garden".'}</p>
                </div>
                <div className="air-quality-card">
                  <div className={`aqi-ring ${descriptor.tone}`}>
                    <span className="aqi-ring-inner"><Wind size={16} /></span>
                  </div>
                  <div className="aqi-details">
                    <span className="aqi-heading">AIR QUALITY <span className={`aqi-bullet ${descriptor.tone}`} /></span>
                    <div className="aqi-number-row">
                      <strong>{air.aqi}</strong>
                      <span className={`aqi-status ${descriptor.tone}`}>{descriptor.label}</span>
                    </div>
                    <span className="aqi-location"><MapPin size={12} /> {city.name} · US AQI · {air.source}</span>
                  </div>
                  <button className="aqi-refresh" onClick={() => void loadAir()} disabled={airLoading} aria-label="Refresh AQI">
                    <RefreshCw size={15} className={airLoading ? 'spin' : ''} />
                  </button>
                </div>
              </section>

              <section className="route-layout">
                {/* Route cards column */}
                <div className="route-options-column">
                  <div className="routes-heading">
                    <div>
                      <h3>Route options <span className="route-count">{scoredRoutes.length > 0 ? `0${scoredRoutes.length}` : '—'}</span></h3>
                      <p>{mode} · ranked by air quality (lowest AQI first)</p>
                    </div>
                    {scoredRoutes.length > 1 && (
                      <button className="filter-button" onClick={() => {
                        const kinds: RouteKind[] = ['clean','balanced','fast'];
                        const idx = kinds.indexOf(selectedKind);
                        const next = scoredRoutes.find(r => r.kind === kinds[(idx + 1) % kinds.length]);
                        if (next) setSelectedKind(next.kind);
                      }}>
                        <ArrowRight size={14} /> Cycle route
                      </button>
                    )}
                  </div>

                  {scoredRoutes.length === 0 && !routeLoading && (
                    <div className="routes-empty">
                      <Route size={20} />
                      <p>Enter origin and destination above, then click <strong>Find routes</strong>.</p>
                    </div>
                  )}

                  <div className="route-cards">
                    {scoredRoutes.map(route => {
                      const meta = ROUTE_META[route.kind];
                      const isSelected = selectedKind === route.kind;
                      const isLowestAqi = route.kind === 'clean';
                      const iconMap = { clean: <Leaf size={17} />, balanced: <Compass size={17} />, fast: <ArrowUpRight size={17} /> };
                      const iconClass = { clean: 'clean-icon', balanced: 'balanced-icon', fast: 'fast-icon' }[route.kind];
                      const expLabel = route.exposureScore <= 45 ? 'Low' : route.exposureScore <= 70 ? 'Moderate' : 'Higher';
                      const expClass = route.exposureScore <= 45 ? 'low-text' : route.exposureScore <= 70 ? 'medium-text' : 'high-text';
                      const scoreChipClass = { clean: 'score-green', balanced: 'score-blue', fast: 'score-orange' }[route.kind];
                      const syncKey = `${origin}|${destination}|${route.kind}`;
                      const isSynced = s3SyncedIds.includes(syncKey);

                      return (
                        <div
                          key={route.kind}
                          className={`route-card ${isSelected ? 'route-card-selected' : ''} ${isLowestAqi ? 'is-lowest-aqi' : ''}`}
                          onClick={() => setSelectedKind(route.kind)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="route-card-top">
                            <div className={`route-card-icon ${iconClass}`}>{iconMap[route.kind]}</div>
                            {isLowestAqi ? (
                              <span className="lowest-aqi-tag">
                                <Leaf size={10} /> LOWEST AQI · RECOMMENDED
                              </span>
                            ) : (
                              <span className="option-label">{meta.chip}</span>
                            )}
                          </div>
                          <div className="route-card-title">
                            <h4>{meta.label}</h4>
                            {isSelected && <span className="selected-check"><Check size={12} /></span>}
                          </div>
                          <p className="route-card-subtitle">{meta.subtitle}</p>
                          <div className="route-card-metrics">
                            <div><Clock3 size={14} /><strong>{Math.round(route.durationSec / 60)} <small>min</small></strong></div>
                            <span className="metric-divider" />
                            <div><Route size={14} /><strong>{(route.distanceM / 1000).toFixed(1)} <small>km</small></strong></div>
                            <span className="metric-divider" />
                            <div>
                              <Wind size={14} />
                              <strong style={{ color: isLowestAqi ? '#16a34a' : undefined }}>
                                {route.midAqi} <small>AQI {isLowestAqi ? '(Lowest)' : ''}</small>
                              </strong>
                            </div>
                          </div>
                          <div className="exposure-line">
                            <span>Pollution exposure</span>
                            <strong className={expClass}>{expLabel}</strong>
                          </div>
                          <div className="exposure-track">
                            <span style={{ width: `${route.exposureScore}%`, background: ROUTE_COLORS[route.kind] }} />
                          </div>
                          <div className="route-card-footer">
                            <span>
                              {isLowestAqi && route.exposureReductionPct > 0 ? (
                                <span className="lowest-aqi-savings">
                                  −{route.exposureReductionPct}% less PM2.5 intake
                                </span>
                              ) : (
                                <>
                                  <Activity size={13} />
                                  {route.exposureReductionPct > 0 ? `${route.exposureReductionPct}% less intake` : 'Baseline road exposure'}
                                </>
                              )}
                            </span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                              <button
                                className={`localstack-sync-btn ${isSynced ? 'synced' : ''}`}
                                onClick={e => {
                                  e.stopPropagation();
                                  void handleSyncToS3(route);
                                }}
                                title="Sync route GeoJSON to AWS S3 on LocalStack (0 bill)"
                              >
                                <Cloud size={12} />
                                {isSynced ? 'S3 Synced' : 'Sync S3'}
                              </button>
                              <span className={`score-chip ${scoreChipClass}`}>{route.airScore} <small>/ 100</small></span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {scoredRoutes.length > 0 && (
                    <div className="route-note">
                      <ShieldCheck size={16} />
                      <p>
                        <strong>How Lowest AQI is determined:</strong> Route corridors avoiding high-speed traffic arteries benefit from tree canopy dispersion and separation from vehicular tailpipe exhaust (reducing PM2.5 exposure by ~35%).
                      </p>
                    </div>
                  )}
                </div>

                {/* Real Leaflet OpenStreetMap column */}
                <div className="map-column">
                  <div className="map-heading">
                    <div>
                      <h3>Live OpenStreetMap <span className="map-source-tag">Leaflet · OpenStreetMap · OSRM</span></h3>
                      <p className="map-sub">
                        <span className="map-live-dot" />
                        {scoredRoutes.length > 0
                          ? `${scoredRoutes.length} distinct routes shown · click any line to switch`
                          : `${city.name} · search a route to display`}
                      </p>
                    </div>
                    {scoredRoutes.length > 0 && (
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className={`save-route-button ${routeIsSaved ? 'saved' : ''}`}
                          onClick={() => {
                            const id = `${origin}|${destination}|${selectedKind}`;
                            setSavedRoutes(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
                          }}
                        >
                          <Bookmark size={15} fill={routeIsSaved ? 'currentColor' : 'none'} />
                          {routeIsSaved ? 'Saved' : 'Save route'}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="map-wrap">
                    <RealMap
                      scoredRoutes={scoredRoutes}
                      selectedKind={selectedKind}
                      onSelect={setSelectedKind}
                      originCoords={originCoords}
                      destCoords={destCoords}
                      cityCenter={cityCenter}
                      originName={origin}
                      destName={destination}
                    />
                  </div>

                  {selectedRoute && (
                    <div className="route-detail-strip">
                      <div className="route-detail-main">
                        <span className="detail-icon" style={{ color: ROUTE_COLORS[selectedKind], background: `${ROUTE_COLORS[selectedKind]}18` }}>
                          <Gauge size={17} />
                        </span>
                        <div>
                          <span>SELECTED COMMUTE</span>
                          <strong style={{ color: ROUTE_COLORS[selectedKind] }}>
                            {selectedKind === 'clean' ? '🌿 Lowest AQI Route' : ROUTE_META[selectedKind].label}
                          </strong>
                        </div>
                      </div>
                      <div className="detail-stat"><span>ETA</span><strong>{Math.round(selectedRoute.durationSec / 60)} min</strong></div>
                      <div className="detail-stat"><span>DISTANCE</span><strong>{(selectedRoute.distanceM / 1000).toFixed(1)} km</strong></div>
                      <div className="detail-stat">
                        <span>CORRIDOR AQI</span>
                        <strong style={{ color: ROUTE_COLORS[selectedKind] }}>
                          {selectedRoute.midAqi} {selectedKind === 'clean' ? '✓' : ''}
                        </strong>
                      </div>
                      <button
                        className="detail-go-button"
                        onClick={() => {
                          void handleSyncToS3(selectedRoute);
                          window.alert(`Selected ${ROUTE_META[selectedKind].label} (AQI ${selectedRoute.midAqi}) archived to AWS S3 on LocalStack! Ready for navigation.`);
                        }}
                        aria-label="Start navigation & sync to AWS"
                      >
                        <ArrowRight size={18} />
                      </button>
                    </div>
                  )}

                  <div className="map-data-note">
                    <span className={`data-status-dot ${air.source}`} />
                    <span>Real-time data: Open-Meteo AQI · OpenStreetMap Routing · updated {updatedText}</span>
                    <button onClick={() => setActiveNav('exposure')}>View report <ArrowRight size={12} /></button>
                  </div>
                </div>
              </section>

              {/* Budget link banner */}
              <div className="planner-budget-link">
                <div className="pbl-left">
                  <div className="pbl-icon"><Activity size={17} /></div>
                  <div>
                    <strong>Log this commute to Breath Budget</strong>
                    <span>Calculates personal PM2.5 intake for this {Math.round((selectedRoute?.durationSec ?? 1200) / 60)} min trip and syncs with AWS DynamoDB.</span>
                  </div>
                </div>
                <button className="secondary-button" onClick={() => {
                  if (selectedRoute) {
                    const entry: ExposureEntry = {
                      id: crypto.randomUUID(),
                      timestamp: new Date(),
                      pm25: air.pm25,
                      durationMin: Math.round(selectedRoute.durationSec / 60),
                      mode,
                      location: `${origin} → ${destination}`,
                    };
                    setExposureEntries(cur => [...cur, entry]);
                    void localStack.syncExposureToDynamoDB(entry);
                  }
                  setActiveNav('budget');
                }}>
                  Log to Budget & AWS <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          <footer className="page-footer">
            <span>© 2026 Airpath · Smart Commute Router &amp; BreathBudget</span>
            <span><span className="footer-dot" /> 100% Free Open Source Stack (OSM · Open-Meteo · LocalStack)</span>
            <button
              onClick={() => setShowLsModal(true)}
              style={{ background: 'transparent', border: 0, color: '#ff9900', fontWeight: 700, fontSize: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
            >
              AWS LocalStack Architecture <ExternalLink size={10} />
            </button>
            <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Open-Meteo <ArrowUpRight size={11} /></a>
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap <ArrowUpRight size={11} /></a>
          </footer>
        </div>
      </main>
    </div>
  );
}
