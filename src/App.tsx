import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellOff,
  Bike,
  Bookmark,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Compass,
  FlaskConical,
  Footprints,
  Gauge,
  Leaf,
  LocateFixed,
  MapPin,
  Menu,
  MoreHorizontal,
  Navigation,
  RefreshCw,
  Route,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Wind,
  X,
} from 'lucide-react';

type Mode = 'Cycle' | 'Walk' | 'Run';
type RouteKind = 'clean' | 'balanced' | 'fast';
type City = { name: string; lat: number; lon: number; area: string };
type AirData = {
  aqi: number; pm25: number; pm10: number; no2: number; ozone: number;
  label: string; source: 'live' | 'sample'; observedAt: Date;
};

// --- BreathBudget types ---
type ExposureEntry = {
  id: string;
  timestamp: Date;
  pm25: number;        // µg/m³ reading at that time
  durationMin: number; // minutes spent outdoors
  mode: Mode;
  location: string;
};

// WHO daily PM2.5 guideline: 15 µg/m³ · 24h average
// We track µg/m³·min (concentration × time) as a proxy for dose
const WHO_DAILY_LIMIT_UG_MIN = 15 * 24 * 60; // ~21600 µg·min/m³ per day
const BUDGET_WARN_FRACTION = 0.65;
const BUDGET_DANGER_FRACTION = 0.90;

// Exertion multipliers: running inhales more than cycling, walking least
const EXERTION: Record<Mode, number> = { Walk: 1.0, Cycle: 1.4, Run: 1.9 };

function calcDose(pm25: number, durationMin: number, mode: Mode) {
  return pm25 * durationMin * EXERTION[mode];
}

function budgetPercent(entries: ExposureEntry[]) {
  const total = entries.reduce(
    (sum, e) => sum + calcDose(e.pm25, e.durationMin, e.mode), 0
  );
  return Math.min(100, (total / WHO_DAILY_LIMIT_UG_MIN) * 100);
}

function budgetRemaining(entries: ExposureEntry[], pm25: number, mode: Mode) {
  const used = entries.reduce((s, e) => s + calcDose(e.pm25, e.durationMin, e.mode), 0);
  const remaining = WHO_DAILY_LIMIT_UG_MIN - used;
  if (remaining <= 0) return 0;
  return Math.floor(remaining / (pm25 * EXERTION[mode]));
}

// -------------------------

const CITIES: City[] = [
  { name: 'New Delhi', lat: 28.6139, lon: 77.209, area: 'Central Delhi, India' },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777, area: 'South Mumbai, India' },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946, area: 'Central Bengaluru, India' },
  { name: 'London', lat: 51.5072, lon: -0.1276, area: 'Central London, UK' },
];

const SAMPLE_AIR: Record<string, AirData> = {
  'New Delhi': { aqi: 154, pm25: 63.4, pm10: 92.1, no2: 31.5, ozone: 41.2, label: 'Unhealthy', source: 'sample', observedAt: new Date() },
  Mumbai:      { aqi: 82,  pm25: 24.8, pm10: 41.1, no2: 19.6, ozone: 34.5, label: 'Moderate',  source: 'sample', observedAt: new Date() },
  Bengaluru:   { aqi: 64,  pm25: 18.4, pm10: 29.6, no2: 13.8, ozone: 28.4, label: 'Moderate',  source: 'sample', observedAt: new Date() },
  London:      { aqi: 27,  pm25: 6.2,  pm10: 11.5, no2: 8.3,  ozone: 24.7, label: 'Good',      source: 'sample', observedAt: new Date() },
};

const ROUTES: Record<RouteKind, {
  title: string; subtitle: string; mins: number; distance: string;
  exposure: number; compared: number; accent: string; risk: string;
  path: string; score: string;
}> = {
  clean: {
    title: 'Green route', subtitle: 'Park paths · quieter streets', mins: 24, distance: '4.8 km',
    exposure: 38, compared: -42, accent: 'green', risk: 'Low exposure',
    path: 'M 78 314 C 160 314 154 250 230 250 S 317 315 385 278 S 444 182 526 190 S 612 251 720 156', score: '92',
  },
  balanced: {
    title: 'Balanced route', subtitle: 'A mix of both', mins: 19, distance: '4.1 km',
    exposure: 61, compared: -18, accent: 'blue', risk: 'Moderate exposure',
    path: 'M 78 314 C 130 314 146 356 220 342 S 300 282 360 300 S 460 275 500 260 S 610 242 720 156', score: '78',
  },
  fast: {
    title: 'Fastest route', subtitle: 'Main roads · fewer turns', mins: 16, distance: '3.6 km',
    exposure: 100, compared: 0, accent: 'orange', risk: 'Higher exposure',
    path: 'M 78 314 C 130 250 214 276 260 215 S 330 188 390 188 S 456 115 534 126 S 625 150 720 156', score: '63',
  },
};

const NAV_ITEMS = [
  { id: 'planner',  label: 'Route planner',  icon: Route },
  { id: 'budget',   label: 'Breath budget',  icon: Wind },
  { id: 'exposure', label: 'Exposure report', icon: Activity },
  { id: 'saved',    label: 'Saved routes',   icon: Bookmark },
];

function routeMinutes(kind: RouteKind, mode: Mode) {
  const times: Record<RouteKind, Record<Mode, number>> = {
    clean:    { Cycle: 24, Walk: 62, Run: 32 },
    balanced: { Cycle: 19, Walk: 53, Run: 25 },
    fast:     { Cycle: 16, Walk: 44, Run: 21 },
  };
  return times[kind][mode];
}

function aqiDescriptor(aqi: number) {
  if (aqi <= 50)  return { label: 'Good',           tone: 'good',          hint: 'Air quality is satisfactory.' };
  if (aqi <= 100) return { label: 'Moderate',        tone: 'moderate',      hint: 'Sensitive groups may notice effects.' };
  if (aqi <= 150) return { label: 'Sensitive groups',tone: 'sensitive',     hint: 'Sensitive people may experience effects.' };
  if (aqi <= 200) return { label: 'Unhealthy',       tone: 'unhealthy',     hint: 'Reduce prolonged outdoor exertion.' };
  if (aqi <= 300) return { label: 'Very unhealthy',  tone: 'very-unhealthy',hint: 'Limit outdoor activity.' };
  return           { label: 'Hazardous',             tone: 'hazardous',     hint: 'Avoid outdoor exertion.' };
}

async function fetchAir(city: City): Promise<AirData> {
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&current=pm10,pm2_5,nitrogen_dioxide,ozone,us_aqi&timezone=auto`;
  const response = await fetch(url);
  if (!response.ok) throw new Error('Air quality feed unavailable');
  const json = await response.json();
  const current = json.current;
  const aqi = Math.round(Number(current.us_aqi));
  if (!Number.isFinite(aqi)) throw new Error('AQI missing from feed');
  return {
    aqi,
    pm25: Number(current.pm2_5),
    pm10: Number(current.pm10),
    no2:  Number(current.nitrogen_dioxide),
    ozone: Number(current.ozone),
    label: aqiDescriptor(aqi).label,
    source: 'live',
    observedAt: current.time ? new Date(current.time) : new Date(),
  };
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-label="Airpath">
      <span className="brand-symbol"><Wind size={18} strokeWidth={2.4} /></span>
      <span>airpath<span className="brand-period">.</span></span>
    </div>
  );
}

function CityMap({ selected, city, origin, destination }: { selected: RouteKind; city: City; origin: string; destination: string }) {
  const active = ROUTES[selected];
  return (
    <div className="map-shell">
      <div className="map-grid" />
      <svg className="map-art" viewBox="0 0 800 430" role="img" aria-label={`Illustrative route map in ${city.name}`} preserveAspectRatio="xMidYMid slice">
        <defs>
          <pattern id="tinyDots" width="17" height="17" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="#d2d8d0" /></pattern>
          <filter id="routeShadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#27382a" floodOpacity=".14" /></filter>
        </defs>
        <rect width="800" height="430" fill="#eef1e9" />
        <rect width="800" height="430" fill="url(#tinyDots)" opacity=".42" />
        <path d="M-20 95 L170 115 L210 65 L366 86 L433 37 L610 68 L816 21" className="minor-road" />
        <path d="M-30 188 L150 157 L245 183 L375 136 L520 166 L663 131 L830 161" className="minor-road" />
        <path d="M-20 395 L110 331 L260 369 L395 340 L538 375 L672 332 L830 356" className="minor-road" />
        <path d="M80 -20 L109 73 L145 168 L135 260 L177 460 M250 -20 L278 80 L269 168 L324 253 L308 440 M430 -10 L412 79 L453 185 L428 280 L466 455 M610 -20 L592 63 L625 156 L604 246 L661 442 M740 -20 L707 78 L745 172 L723 268 L777 435" className="minor-road" />
        <path d="M28 30 L82 46 L123 30 L183 53 L205 97 L165 124 L106 114 L62 147 L21 130 Z" className="block-fill" />
        <path d="M337 22 L391 16 L414 49 L402 94 L345 110 L319 73 Z" className="block-fill" />
        <path d="M505 201 L578 190 L606 222 L585 268 L532 275 L499 243 Z" className="block-fill" />
        <path d="M658 37 L716 28 L748 67 L723 104 L679 102 L650 72 Z" className="block-fill" />
        <path d="M16 244 L63 224 L101 252 L93 300 L43 313 L8 282 Z" className="block-fill" />
        <path d="M180 203 L215 193 L247 223 L229 257 L191 252 L170 229 Z" className="block-fill" />
        <path d="M342 145 L382 124 L414 150 L400 180 L357 188 L330 166 Z" className="block-fill" />
        <path d="M659 289 L709 280 L733 311 L714 346 L671 351 L646 323 Z" className="block-fill" />
        <path d="M237 25 C194 65 204 119 244 154 C270 177 274 204 242 230 C201 265 207 306 238 330 C260 347 268 389 233 454 L296 454 C328 405 309 355 284 329 C252 295 252 274 289 244 C326 214 328 171 295 142 C264 115 266 74 291 34 Z" fill="#d6e9df" opacity=".92" />
        <path d="M520 -15 C483 40 506 87 537 112 C565 137 569 172 536 200 C502 228 510 279 548 307 C576 329 587 374 561 445" fill="none" stroke="#dcebe2" strokeWidth="28" strokeLinecap="round" />
        <path d="M42 70 L98 76 L129 104 L154 89 L181 102 M348 55 L375 69 L389 94 M477 56 L512 83 L553 71 M668 126 L703 138 L734 119 M39 352 L77 329 L113 351 M342 375 L369 357 L405 373 M622 391 L659 363 L701 378" className="building-line" />
        <path d="M80 314 C160 314 154 250 230 250 S317 315 385 278 S444 182 526 190 S612 251 720 156" className="route-underlay" />
        <path d="M130 365 C205 392 219 349 263 348 S320 375 355 364" className="road-highlight" />
        <path d={ROUTES.fast.path}     className={`map-route route-orange ${selected === 'fast'     ? 'route-selected' : ''}`} />
        <path d={ROUTES.balanced.path} className={`map-route route-blue  ${selected === 'balanced' ? 'route-selected' : ''}`} />
        <path d={ROUTES.clean.path}    className={`map-route route-green ${selected === 'clean'    ? 'route-selected' : ''}`} />
        {selected === 'fast'     && <path d={ROUTES.fast.path}     className="route-glow orange-glow" />}
        {selected === 'balanced' && <path d={ROUTES.balanced.path} className="route-glow blue-glow" />}
        {selected === 'clean'    && <path d={ROUTES.clean.path}    className="route-glow green-glow" />}
        <g className="map-pin start-pin" transform="translate(78 314)"><circle r="18" className="pin-halo" /><circle r="11" className="pin-dot" /><circle r="4" fill="white" /></g>
        <g className="map-pin end-pin"   transform="translate(720 156)"><circle r="20" className="pin-halo" /><circle r="12" className="pin-destination" /><path d="M-4 0 L-1 4 L5 -4" stroke="white" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></g>
        <g className="map-label" transform="translate(36 350)"><rect width="108" height="25" rx="8" /><text x="12" y="16">{origin.length > 15 ? origin.slice(0, 14) + '…' : origin}</text></g>
        <g className="map-label" transform="translate(604 112)"><rect width="150" height="25" rx="8" /><text x="12" y="16">{destination.length > 20 ? destination.slice(0, 19) + '…' : destination}</text></g>
        <g transform="translate(475 293)"><rect className="hotspot-tag" width="132" height="29" rx="9" /><circle cx="15" cy="14.5" r="4" fill="#e69e50" /><text x="26" y="18.5" className="hotspot-text">Traffic hotspot</text></g>
        <g transform="translate(287 64)"><rect className="park-label" width="109" height="27" rx="8" /><text x="13" y="17.5" className="park-text">Green corridor</text></g>
        <g transform="translate(18 18)"><rect className="map-city-tag" width="145" height="28" rx="8" /><circle cx="14" cy="14" r="3.5" fill="#84a98b" /><text x="25" y="18" className="city-tag-text">{city.name} · concept map</text></g>
      </svg>
      <div className="map-controls">
        <button aria-label="Center route" className="map-control"><LocateFixed size={17} /></button>
        <button aria-label="Map layers" className="map-control"><SlidersHorizontal size={17} /></button>
      </div>
      <div className="map-legend"><span><i className="legend-dot legend-green" />Lower exposure</span><span><i className="legend-dot legend-orange" />Traffic hotspot</span></div>
      <div className="map-active-route">
        <div className={`route-icon-mini ${active.accent}`}><Leaf size={15} /></div>
        <div><span className="active-route-label">SELECTED ROUTE</span><strong>{active.title}</strong></div>
        <div className="route-score"><b>{active.score}</b><span>air score</span></div>
      </div>
      <div className="map-disclaimer">Illustrative geometry · not turn-by-turn navigation</div>
    </div>
  );
}

// ---- BreathBudget screen ----
function BreathBudgetScreen({
  air, city, mode, entries, onAddEntry, onClearToday,
}: {
  air: AirData; city: City; mode: Mode;
  entries: ExposureEntry[];
  onAddEntry: (e: ExposureEntry) => void;
  onClearToday: () => void;
}) {
  const [logDuration, setLogDuration] = useState(20);
  const [logLocation, setLogLocation] = useState('');
  const [alertsOn, setAlertsOn] = useState(true);

  const pct = budgetPercent(entries);
  const remaining = budgetRemaining(entries, air.pm25, mode);
  const warn = pct >= BUDGET_WARN_FRACTION * 100;
  const danger = pct >= BUDGET_DANGER_FRACTION * 100;

  const barColor = danger ? '#cf6b4a' : warn ? '#d4a03a' : '#4d8a68';
  const statusLabel = danger ? 'Budget critical' : warn ? 'Budget warning' : 'Budget healthy';
  const statusTone = danger ? 'danger' : warn ? 'warn' : 'ok';

  const totalDose = entries.reduce((s, e) => s + calcDose(e.pm25, e.durationMin, e.mode), 0);
  const totalMinutes = entries.reduce((s, e) => s + e.durationMin, 0);

  function addEntry() {
    const entry: ExposureEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date(),
      pm25: air.pm25,
      durationMin: logDuration,
      mode,
      location: logLocation.trim() || city.name,
    };
    onAddEntry(entry);
    setLogLocation('');
    setLogDuration(20);
  }

  return (
    <section className="budget-page">
      <div className="section-title-row">
        <div>
          <h2>Breath budget</h2>
          <p>Daily PM2.5 exposure tracker · resets at midnight · WHO 15 µg/m³ guideline</p>
        </div>
        <div className="budget-header-actions">
          <button
            className="icon-toggle-button"
            onClick={() => setAlertsOn(a => !a)}
            aria-label={alertsOn ? 'Mute alerts' : 'Enable alerts'}
            title={alertsOn ? 'Alerts on' : 'Alerts off'}
          >
            {alertsOn ? <Bell size={15} /> : <BellOff size={15} />}
            <span>{alertsOn ? 'Alerts on' : 'Alerts off'}</span>
          </button>
          <button className="secondary-button" onClick={onClearToday}>Reset today</button>
        </div>
      </div>

      {/* Alert banner */}
      {alertsOn && danger && (
        <div className="budget-alert danger-alert">
          <AlertTriangle size={16} />
          <strong>Daily limit reached.</strong>
          <span>You have used {pct.toFixed(0)}% of your estimated safe daily PM2.5 intake.</span>
        </div>
      )}
      {alertsOn && warn && !danger && (
        <div className="budget-alert warn-alert">
          <AlertTriangle size={16} />
          <strong>Budget running low.</strong>
          <span>{pct.toFixed(0)}% used — {remaining} min of {mode.toLowerCase()} remaining at current AQI.</span>
        </div>
      )}

      {/* Budget ring + KPIs */}
      <div className="budget-top-grid">
        {/* Gauge */}
        <div className={`budget-gauge-card ${statusTone}`}>
          <div className="gauge-label-row">
            <span className="gauge-kicker">TODAY'S BUDGET USED</span>
            <span className={`budget-status-pill ${statusTone}`}>{statusLabel}</span>
          </div>
          <div className="gauge-ring-wrap">
            <svg viewBox="0 0 120 120" className="gauge-svg" role="img" aria-label={`${pct.toFixed(0)}% of daily budget used`}>
              <circle cx="60" cy="60" r="50" fill="none" stroke="#e8ece5" strokeWidth="12" />
              <circle
                cx="60" cy="60" r="50" fill="none"
                stroke={barColor} strokeWidth="12"
                strokeDasharray={`${(pct / 100) * 314} 314`}
                strokeLinecap="round"
                transform="rotate(-90 60 60)"
                style={{ transition: 'stroke-dasharray 0.6s ease' }}
              />
              <text x="60" y="56" textAnchor="middle" className="gauge-pct-text">{pct.toFixed(0)}%</text>
              <text x="60" y="72" textAnchor="middle" className="gauge-sub-text">used</text>
            </svg>
          </div>
          <div className="gauge-footer">
            <div className="gauge-stat">
              <span>Remaining (est.)</span>
              <strong>{remaining > 0 ? `${remaining} min` : 'None'}</strong>
            </div>
            <div className="gauge-stat">
              <span>Mode</span>
              <strong>{mode}</strong>
            </div>
            <div className="gauge-stat">
              <span>AQI now</span>
              <strong>{air.aqi}</strong>
            </div>
          </div>
        </div>

        {/* KPIs */}
        <div className="budget-kpi-stack">
          <div className="budget-kpi">
            <span>Outdoor minutes today</span>
            <strong>{totalMinutes}</strong>
            <em>logged trips</em>
          </div>
          <div className="budget-kpi">
            <span>Dose accumulated</span>
            <strong>{(totalDose / 1000).toFixed(1)}<small>k µg·min/m³</small></strong>
            <em>exertion-adjusted</em>
          </div>
          <div className="budget-kpi">
            <span>Current PM2.5</span>
            <strong>{Number.isFinite(air.pm25) ? air.pm25.toFixed(1) : '—'}<small> µg/m³</small></strong>
            <em>{city.name} · {air.source === 'live' ? 'live' : 'sample'}</em>
          </div>
          <div className="budget-kpi">
            <span>Exertion factor</span>
            <strong>×{EXERTION[mode].toFixed(1)}</strong>
            <em>{mode} breathing rate</em>
          </div>
        </div>
      </div>

      {/* Log a trip */}
      <div className="budget-log-panel panel">
        <div className="panel-heading">
          <div>
            <h3>Log an outdoor trip</h3>
            <p>Records PM2.5 at current AQI reading for the duration entered.</p>
          </div>
          <span className="panel-icon"><TrendingUp size={17} /></span>
        </div>
        <div className="log-form">
          <label className="log-field">
            <span>Duration (minutes)</span>
            <input
              type="number" min={1} max={480}
              value={logDuration}
              onChange={e => setLogDuration(Math.max(1, Number(e.target.value)))}
              aria-label="Trip duration in minutes"
            />
          </label>
          <label className="log-field">
            <span>Location label</span>
            <input
              type="text" placeholder={city.name}
              value={logLocation}
              onChange={e => setLogLocation(e.target.value)}
              aria-label="Trip location label"
            />
          </label>
          <div className="log-field log-mode-display">
            <span>Mode</span>
            <strong>{mode} ×{EXERTION[mode].toFixed(1)}</strong>
          </div>
          <div className="log-field log-pm-display">
            <span>PM2.5 (current)</span>
            <strong>{Number.isFinite(air.pm25) ? air.pm25.toFixed(1) : '—'} µg/m³</strong>
          </div>
          <button className="primary-button" onClick={addEntry}>
            Log trip <ArrowRight size={15} />
          </button>
        </div>
        <p className="log-note">
          <FlaskConical size={12} />
          Dose = PM2.5 × minutes × breathing multiplier. This is an estimate; not a calibrated personal exposure measurement.
        </p>
      </div>

      {/* Trip log */}
      <div className="budget-log-list">
        <div className="log-list-header">
          <span>Today's trips</span>
          <span>{entries.length} logged</span>
        </div>
        {entries.length === 0 ? (
          <div className="log-empty">No trips logged today. Use the form above to start tracking.</div>
        ) : (
          [...entries].reverse().map(entry => {
            const dose = calcDose(entry.pm25, entry.durationMin, entry.mode);
            const frac = Math.min(100, (dose / (WHO_DAILY_LIMIT_UG_MIN / 10)) * 100);
            return (
              <div className="log-row" key={entry.id}>
                <div className="log-row-time">
                  {entry.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </div>
                <div className="log-row-info">
                  <strong>{entry.location}</strong>
                  <span>{entry.durationMin} min · {entry.mode} · PM2.5 {entry.pm25.toFixed(1)} µg/m³</span>
                </div>
                <div className="log-row-dose">
                  <strong>{(dose / 1000).toFixed(2)}k</strong>
                  <span>µg·min/m³</span>
                  <div className="log-dose-bar"><i style={{ width: `${frac}%`, background: frac > 70 ? '#cf6b4a' : frac > 40 ? '#d4a03a' : '#4d8a68' }} /></div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ---- Main App ----
function App() {
  const [activeNav, setActiveNav] = useState('planner');
  const [mode, setMode] = useState<Mode>('Cycle');
  const [selectedRoute, setSelectedRoute] = useState<RouteKind>('clean');
  const [city, setCity] = useState<City>(CITIES[0]);
  const [origin, setOrigin] = useState('Connaught Place');
  const [destination, setDestination] = useState('Lodhi Garden');
  const [air, setAir] = useState<AirData>(SAMPLE_AIR['New Delhi']);
  const [airLoading, setAirLoading] = useState(false);
  const [airError, setAirError] = useState('');
  const [routeReady, setRouteReady] = useState(true);
  const [savedRoutes, setSavedRoutes] = useState<string[]>([]);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [showCityMenu, setShowCityMenu] = useState(false);
  const [updatedText, setUpdatedText] = useState('just now');

  // BreathBudget state
  const [exposureEntries, setExposureEntries] = useState<ExposureEntry[]>([]);

  const loadAir = useCallback(async (target = city) => {
    setAirLoading(true);
    setAirError('');
    try {
      const result = await fetchAir(target);
      setAir(result);
      setUpdatedText('just now');
    } catch {
      setAir(SAMPLE_AIR[target.name] ?? SAMPLE_AIR['New Delhi']);
      setAirError('Live feed unavailable — showing sample readings.');
      setUpdatedText('sample data');
    } finally {
      setAirLoading(false);
    }
  }, [city]);

  useEffect(() => { void loadAir(CITIES[0]); }, []);

  const descriptor = aqiDescriptor(air.aqi);
  const activeRoute = ROUTES[selectedRoute];
  const routeIsSaved = savedRoutes.includes(`${origin}|${destination}|${selectedRoute}`);

  const pageTitle = useMemo(() => {
    if (activeNav === 'exposure') return 'Exposure report';
    if (activeNav === 'saved')    return 'Saved routes';
    if (activeNav === 'budget')   return 'Breath budget';
    return 'Route planner';
  }, [activeNav]);

  const planRoute = () => { setRouteReady(true); setActiveNav('planner'); };
  const reverseRoute = () => { setOrigin(destination); setDestination(origin); setRouteReady(false); };
  const saveCurrentRoute = () => {
    const id = `${origin}|${destination}|${selectedRoute}`;
    setSavedRoutes(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setAirError('Location not supported by this browser.'); return; }
    navigator.geolocation.getCurrentPosition(async pos => {
      const target: City = { name: 'Your location', lat: pos.coords.latitude, lon: pos.coords.longitude, area: 'Approximate current location' };
      setCity(target); setAirLoading(true); setAirError('');
      try { const r = await fetchAir(target); setAir(r); setUpdatedText('just now'); }
      catch { setAir(SAMPLE_AIR['New Delhi']); setAirError('Could not load local AQI; sample values shown.'); }
      finally { setAirLoading(false); }
    }, () => setAirError('Location permission denied. Choose a city instead.'), { timeout: 9000 });
  };

  return (
    <div className="app-shell">
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
              <button
                key={item.id}
                className={`nav-item ${activeNav === item.id ? 'nav-active' : ''}`}
                onClick={() => { setActiveNav(item.id); setShowMobileMenu(false); }}
              >
                <Icon size={18} strokeWidth={1.9} />
                <span>{item.label}</span>
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
            {CITIES.map(option => (
              <button key={option.name} onClick={() => { setCity(option); setShowCityMenu(false); void loadAir(option); }}>
                {option.name}{city.name === option.name && <Check size={14} />}
              </button>
            ))}
          </div>
        )}
        <button className="sidebar-location" onClick={useMyLocation}><LocateFixed size={15} /> Use my location</button>

        {/* Budget summary in sidebar */}
        {exposureEntries.length > 0 && (
          <div className="sidebar-budget-mini">
            <div className="sbm-label">TODAY'S BUDGET</div>
            <div className="sbm-bar-wrap">
              <div
                className="sbm-bar"
                style={{
                  width: `${budgetPercent(exposureEntries)}%`,
                  background: budgetPercent(exposureEntries) >= 90 ? '#cf6b4a' : budgetPercent(exposureEntries) >= 65 ? '#d4a03a' : '#4d8a68',
                }}
              />
            </div>
            <span className="sbm-pct">{budgetPercent(exposureEntries).toFixed(0)}% used</span>
          </div>
        )}

        <div className="sidebar-bottom">
          <button
            className="nav-item help-link"
            onClick={() => window.alert('Airpath is a prototype. AQI data via Open-Meteo when available; route geometry and exposure scores are illustrative. Breath budget uses a simplified dose model (PM2.5 × time × breathing rate) — not a calibrated personal dose.')}
          >
            <CircleHelp size={18} /><span>Help & about</span>
          </button>
          <div className="profile-row">
            <div className="profile-avatar">BS</div>
            <div className="profile-copy"><strong>Bhaumik</strong><span>Personal account</span></div>
            <MoreHorizontal size={18} className="muted-icon" />
          </div>
        </div>
      </aside>

      {showMobileMenu && <button className="mobile-backdrop" aria-label="Close menu overlay" onClick={() => setShowMobileMenu(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left">
            <button className="mobile-menu-button" aria-label="Open menu" onClick={() => setShowMobileMenu(true)}><Menu size={20} /></button>
            <span className="breadcrumb">Airpath</span>
            <span className="crumb-slash">/</span>
            <span className="breadcrumb-current">{pageTitle}</span>
          </div>
          <div className="topbar-right">
            <span className="live-status">
              <span className="live-dot" />
              {air.source === 'live' ? 'AQI live' : 'Sample data'}
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
              <div className="eyebrow"><span className="eyebrow-line" /> AIRPATH <span className="eyebrow-separator">/</span> {pageTitle.toUpperCase()}</div>
              <h1>
                {activeNav === 'exposure' ? 'Pollutant breakdown.' :
                 activeNav === 'saved'    ? 'Saved routes.' :
                 activeNav === 'budget'   ? 'Breath budget.' :
                 'Route by air quality.'}
              </h1>
              <p>
                {activeNav === 'exposure' ? `Current readings for ${city.name} — PM2.5, PM10, NO₂, ozone.` :
                 activeNav === 'saved'    ? 'Your bookmarked lower-exposure routes.' :
                 activeNav === 'budget'   ? 'Track cumulative daily PM2.5 intake against the WHO 24h guideline.' :
                 'Compare routes by time and estimated pollution exposure.'}
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

          {/* ===== BREATH BUDGET ===== */}
          {activeNav === 'budget' && (
            <BreathBudgetScreen
              air={air} city={city} mode={mode}
              entries={exposureEntries}
              onAddEntry={e => setExposureEntries(cur => [...cur, e])}
              onClearToday={() => setExposureEntries([])}
            />
          )}

          {/* ===== SAVED ROUTES ===== */}
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
                    const route = ROUTES[kind];
                    return (
                      <article className="saved-card" key={item}>
                        <div className={`saved-card-icon ${route.accent}`}><Route size={18} /></div>
                        <span className="saved-pill">Saved</span>
                        <h3>{from} <ArrowRight size={15} /> {to}</h3>
                        <p>{route.title} · {route.distance} · {route.mins} min</p>
                        <div className="saved-card-bottom">
                          <span><Leaf size={14} /> {route.risk}</span>
                          <button onClick={() => { setOrigin(from); setDestination(to); setSelectedRoute(kind); setActiveNav('planner'); }}>Open route <ArrowRight size={14} /></button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {/* ===== EXPOSURE REPORT ===== */}
          {activeNav === 'exposure' && (
            <section className="exposure-page">
              <div className="section-title-row">
                <div><h2>Exposure snapshot</h2><p>Current city reading — {city.name}.</p></div>
                <button className="secondary-button" onClick={() => void loadAir()}><RefreshCw size={15} className={airLoading ? 'spin' : ''} /> Refresh</button>
              </div>
              <div className="exposure-kpis">
                <div className="exposure-kpi">
                  <span>Current US AQI</span>
                  <strong>{air.aqi}</strong>
                  <em className={`status-text ${descriptor.tone}`}>{descriptor.label}</em>
                </div>
                <div className="exposure-kpi">
                  <span>Clean-route exposure vs fastest</span>
                  <strong>−42%</strong>
                  <em>illustrative estimate</em>
                </div>
                <div className="exposure-kpi">
                  <span>Selected route air score</span>
                  <strong>{activeRoute.score}<small>/100</small></strong>
                  <em>{activeRoute.title}</em>
                </div>
              </div>
              <div className="exposure-content-grid">
                <div className="panel pollutant-panel">
                  <div className="panel-heading">
                    <div><h3>Pollutants</h3><p>Current reading · {city.name}</p></div>
                    <span className="panel-icon"><Wind size={17} /></span>
                  </div>
                  {[
                    { name: 'PM2.5',          value: air.pm25,  unit: 'µg/m³', tag: 'Fine particles',        max: 75 },
                    { name: 'PM10',           value: air.pm10,  unit: 'µg/m³', tag: 'Coarse particles',      max: 120 },
                    { name: 'Nitrogen dioxide',value: air.no2,   unit: 'µg/m³', tag: 'Traffic-related',       max: 80 },
                    { name: 'Ozone',          value: air.ozone, unit: 'µg/m³', tag: 'Ground-level ozone',    max: 80 },
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
                      ? 'Data from Open-Meteo air quality API · indicative city-level data'
                      : 'Sample readings · live feed unavailable'}
                  </div>
                </div>

                <div className="panel insight-panel">
                  <div className="insight-orb"><Leaf size={25} /></div>
                  <span className="insight-label">ROUTE COMPARISON</span>
                  <h3>Green route vs. fastest route</h3>
                  <p>Choosing quieter streets and park paths typically reduces exposure to traffic-related pollutants. Actual exposure depends on weather, time of day, exertion level, and local conditions.</p>
                  <div className="insight-stat"><span>Exposure estimate (clean vs. fast)</span><strong>−42%</strong></div>
                  <div className="insight-divider" />
                  <div className="insight-stat"><span>Extra travel time</span><strong>+8 min</strong></div>
                  <div className="insight-divider" />
                  <div className="insight-stat"><span>WHO daily PM2.5 guideline</span><strong>15 µg/m³</strong></div>
                  <button className="primary-button full-width" onClick={() => setActiveNav('planner')}>Compare routes <ArrowRight size={16} /></button>
                  <div className="insight-note">Illustrative estimates · not a measured personal dose</div>
                </div>
              </div>
            </section>
          )}

          {/* ===== ROUTE PLANNER ===== */}
          {activeNav === 'planner' && (
            <>
              <section className="route-search panel">
                <div className="search-label">
                  <div className="search-label-icon"><Navigation size={16} /></div>
                  <span>PLAN YOUR JOURNEY</span>
                  <span className="search-demo">Prototype</span>
                </div>
                <div className="search-controls">
                  <div className="location-fields">
                    <label className="location-input origin-field">
                      <span className="location-marker origin-marker" />
                      <span className="input-caption">FROM</span>
                      <input aria-label="Starting location" value={origin}
                        onChange={e => { setOrigin(e.target.value); setRouteReady(false); }}
                        onKeyDown={e => e.key === 'Enter' && planRoute()}
                        placeholder="Start point" />
                    </label>
                    <button className="swap-button" aria-label="Swap origin and destination" onClick={reverseRoute}><ArrowDownUp size={16} /></button>
                    <label className="location-input destination-field">
                      <span className="location-marker destination-marker" />
                      <span className="input-caption">TO</span>
                      <input aria-label="Destination" value={destination}
                        onChange={e => { setDestination(e.target.value); setRouteReady(false); }}
                        onKeyDown={e => e.key === 'Enter' && planRoute()}
                        placeholder="Destination" />
                    </label>
                  </div>
                  <button className="primary-button plan-button" onClick={planRoute} disabled={!origin.trim() || !destination.trim()}>
                    <Search size={16} /> Find routes
                  </button>
                </div>
                <div className="search-bottom">
                  <div className="mode-picker">
                    <span>MODE</span>
                    <button className={mode === 'Cycle' ? 'mode-active' : ''} onClick={() => setMode('Cycle')}><Bike size={16} /> Cycle</button>
                    <button className={mode === 'Walk'  ? 'mode-active' : ''} onClick={() => setMode('Walk')}><Footprints size={16} /> Walk</button>
                    <button className={mode === 'Run'   ? 'mode-active' : ''} onClick={() => setMode('Run')}><Activity size={16} /> Run</button>
                  </div>
                  <div className="avoid-setting">
                    <span className="avoid-check"><Check size={12} /></span>
                    <span>Avoid high-pollution zones</span>
                    <span className="setting-tag">ON</span>
                  </div>
                </div>
                {!routeReady && <div className="route-edit-note">Endpoints updated — press "Find routes" to refresh.</div>}
              </section>

              {airError && <div className="live-warning"><Wind size={14} /><span>{airError}</span></div>}

              <section className="overview-row">
                <div className="overview-title">
                  <span className="section-kicker">ROUTE OVERVIEW</span>
                  <h2>Compare by time and air.</h2>
                  <p>Exposure values are illustrative estimates relative to the fastest route.</p>
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
                    <span className="aqi-location"><MapPin size={12} /> {city.name} · US AQI</span>
                  </div>
                  <button className="aqi-refresh" onClick={() => void loadAir()} title="Refresh" aria-label="Refresh air quality" disabled={airLoading}>
                    <RefreshCw size={15} className={airLoading ? 'spin' : ''} />
                  </button>
                </div>
              </section>

              <section className="route-layout">
                <div className="route-options-column">
                  <div className="routes-heading">
                    <div>
                      <h3>Suggested routes <span className="route-count">03</span></h3>
                      <p>{mode} · {city.name}</p>
                    </div>
                    <button className="filter-button" onClick={() => setSelectedRoute(s => s === 'clean' ? 'balanced' : s === 'balanced' ? 'fast' : 'clean')}>
                      <ArrowRight size={14} /> Next
                    </button>
                  </div>
                  <div className="route-cards">
                    {/* Clean */}
                    <button className={`route-card ${selectedRoute === 'clean' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('clean')}>
                      <div className="route-card-top">
                        <div className="route-card-icon clean-icon"><Leaf size={17} /></div>
                        <span className="recommended-label">LOWEST EXPOSURE</span>
                      </div>
                      <div className="route-card-title">
                        <h4>Green route</h4>
                        {selectedRoute === 'clean' && <span className="selected-check"><Check size={12} /></span>}
                      </div>
                      <p className="route-card-subtitle">Park paths · quieter streets</p>
                      <div className="route-card-metrics">
                        <div><Clock3 size={14} /><strong>{routeMinutes('clean', mode)} <small>min</small></strong></div>
                        <span className="metric-divider" />
                        <div><Route size={14} /><strong>4.8 <small>km</small></strong></div>
                      </div>
                      <div className="exposure-line"><span>Pollution exposure</span><strong className="low-text">Low</strong></div>
                      <div className="exposure-track"><span style={{ width: '38%' }} /></div>
                      <div className="route-card-footer">
                        <span><Leaf size={13} /> 42% less exposure</span>
                        <span className="score-chip score-green">92 <small>/ 100</small></span>
                      </div>
                    </button>
                    {/* Balanced */}
                    <button className={`route-card ${selectedRoute === 'balanced' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('balanced')}>
                      <div className="route-card-top">
                        <div className="route-card-icon balanced-icon"><Compass size={17} /></div>
                        <span className="option-label">BALANCED</span>
                      </div>
                      <div className="route-card-title">
                        <h4>Balanced route</h4>
                        {selectedRoute === 'balanced' && <span className="selected-check"><Check size={12} /></span>}
                      </div>
                      <p className="route-card-subtitle">Mix of quieter and main roads</p>
                      <div className="route-card-metrics">
                        <div><Clock3 size={14} /><strong>{routeMinutes('balanced', mode)} <small>min</small></strong></div>
                        <span className="metric-divider" />
                        <div><Route size={14} /><strong>4.1 <small>km</small></strong></div>
                      </div>
                      <div className="exposure-line"><span>Pollution exposure</span><strong className="medium-text">Moderate</strong></div>
                      <div className="exposure-track"><span style={{ width: '61%' }} /></div>
                      <div className="route-card-footer">
                        <span><Activity size={13} /> 18% less exposure</span>
                        <span className="score-chip score-blue">78 <small>/ 100</small></span>
                      </div>
                    </button>
                    {/* Fast */}
                    <button className={`route-card ${selectedRoute === 'fast' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('fast')}>
                      <div className="route-card-top">
                        <div className="route-card-icon fast-icon"><ArrowUpRight size={17} /></div>
                        <span className="option-label">FASTEST</span>
                      </div>
                      <div className="route-card-title">
                        <h4>Fastest route</h4>
                        {selectedRoute === 'fast' && <span className="selected-check"><Check size={12} /></span>}
                      </div>
                      <p className="route-card-subtitle">Main roads · fewer turns</p>
                      <div className="route-card-metrics">
                        <div><Clock3 size={14} /><strong>{routeMinutes('fast', mode)} <small>min</small></strong></div>
                        <span className="metric-divider" />
                        <div><Route size={14} /><strong>3.6 <small>km</small></strong></div>
                      </div>
                      <div className="exposure-line"><span>Pollution exposure</span><strong className="high-text">Higher</strong></div>
                      <div className="exposure-track"><span style={{ width: '100%' }} /></div>
                      <div className="route-card-footer">
                        <span><Activity size={13} /> Baseline</span>
                        <span className="score-chip score-orange">63 <small>/ 100</small></span>
                      </div>
                    </button>
                  </div>
                  <div className="route-note">
                    <ShieldCheck size={16} />
                    <p>All exposure values are illustrative prototype estimates relative to the fastest route. Actual exposure depends on street-level conditions, weather, and exertion.</p>
                  </div>
                </div>

                <div className="map-column">
                  <div className="map-heading">
                    <div>
                      <h3>Route preview</h3>
                      <p><span className="map-live-dot" /> {city.name} <span className="dot-separator">·</span> Air-aware map</p>
                    </div>
                    <button className={`save-route-button ${routeIsSaved ? 'saved' : ''}`} onClick={saveCurrentRoute}>
                      <Bookmark size={15} fill={routeIsSaved ? 'currentColor' : 'none'} /> {routeIsSaved ? 'Saved' : 'Save route'}
                    </button>
                  </div>
                  <CityMap selected={selectedRoute} city={city} origin={origin || 'Start'} destination={destination || 'Destination'} />
                  <div className="route-detail-strip">
                    <div className="route-detail-main">
                      <span className="detail-icon"><Gauge size={17} /></span>
                      <div>
                        <span>SELECTED</span>
                        <strong>{activeRoute.title}</strong>
                      </div>
                    </div>
                    <div className="detail-stat"><span>ETA</span><strong>{routeMinutes(selectedRoute, mode)} min</strong></div>
                    <div className="detail-stat">
                      <span>EXPOSURE</span>
                      <strong className={selectedRoute === 'clean' ? 'low-text' : selectedRoute === 'balanced' ? 'medium-text' : 'high-text'}>
                        {selectedRoute === 'clean' ? 'Low' : selectedRoute === 'balanced' ? 'Medium' : 'Higher'}
                      </strong>
                    </div>
                    <button className="detail-go-button" onClick={() => window.alert('Navigation handoff is not implemented in this prototype.')} aria-label="Start navigation">
                      <ArrowRight size={18} />
                    </button>
                  </div>
                  <div className="map-data-note">
                    <span className={`data-status-dot ${air.source}`} />
                    <span>
                      {air.source === 'live' ? 'Live city-level AQI · Open-Meteo' : 'Sample air-quality data'}{' '}
                      <span className="dot-separator">·</span> updated {updatedText}
                    </span>
                    <button onClick={() => setActiveNav('exposure')}>View report <ArrowRight size={12} /></button>
                  </div>
                </div>
              </section>

              {/* Bottom strip: link to budget */}
              <div className="planner-budget-link">
                <div className="pbl-left">
                  <div className="pbl-icon"><Activity size={17} /></div>
                  <div>
                    <strong>Track your daily intake</strong>
                    <span>Log this trip to your Breath Budget to track cumulative PM2.5 exposure.</span>
                  </div>
                </div>
                <button className="secondary-button" onClick={() => setActiveNav('budget')}>
                  Open budget <ArrowRight size={14} />
                </button>
              </div>
            </>
          )}

          <footer className="page-footer">
            <span>© 2026 Airpath</span>
            <span><span className="footer-dot" /> Prototype — data is indicative, not a calibrated personal dose</span>
            <a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Air data: Open-Meteo <ArrowUpRight size={12} /></a>
          </footer>
        </div>
      </main>
    </div>
  );
}

export default App;
