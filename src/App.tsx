import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Bike,
  Bookmark,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Compass,
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
  Sparkles,
  Wind,
  X,
} from 'lucide-react';

type Mode = 'Cycle' | 'Walk' | 'Run';
type RouteKind = 'clean' | 'balanced' | 'fast';
type City = { name: string; lat: number; lon: number; area: string };
type AirData = { aqi: number; pm25: number; pm10: number; no2: number; ozone: number; label: string; source: 'live' | 'sample'; observedAt: Date };

const CITIES: City[] = [
  { name: 'New Delhi', lat: 28.6139, lon: 77.209, area: 'Central Delhi, India' },
  { name: 'Mumbai', lat: 19.076, lon: 72.8777, area: 'South Mumbai, India' },
  { name: 'Bengaluru', lat: 12.9716, lon: 77.5946, area: 'Central Bengaluru, India' },
  { name: 'London', lat: 51.5072, lon: -0.1276, area: 'Central London, UK' },
];

const SAMPLE_AIR: Record<string, AirData> = {
  'New Delhi': { aqi: 154, pm25: 63.4, pm10: 92.1, no2: 31.5, ozone: 41.2, label: 'Unhealthy', source: 'sample', observedAt: new Date() },
  Mumbai: { aqi: 82, pm25: 24.8, pm10: 41.1, no2: 19.6, ozone: 34.5, label: 'Moderate', source: 'sample', observedAt: new Date() },
  Bengaluru: { aqi: 64, pm25: 18.4, pm10: 29.6, no2: 13.8, ozone: 28.4, label: 'Moderate', source: 'sample', observedAt: new Date() },
  London: { aqi: 27, pm25: 6.2, pm10: 11.5, no2: 8.3, ozone: 24.7, label: 'Good', source: 'sample', observedAt: new Date() },
};

const ROUTES: Record<RouteKind, { title: string; subtitle: string; mins: number; distance: string; exposure: number; compared: number; accent: string; risk: string; points: string; path: string; score: string }> = {
  clean: {
    title: 'The greener way', subtitle: 'Park paths · quieter streets', mins: 24, distance: '4.8 km', exposure: 38, compared: -42, accent: 'green', risk: 'Low exposure',
    points: '0,0', path: 'M 78 314 C 160 314 154 250 230 250 S 317 315 385 278 S 444 182 526 190 S 612 251 720 156', score: '92',
  },
  balanced: {
    title: 'The balanced route', subtitle: 'A little of both', mins: 19, distance: '4.1 km', exposure: 61, compared: -18, accent: 'blue', risk: 'Moderate exposure',
    points: '0,0', path: 'M 78 314 C 130 314 146 356 220 342 S 300 282 360 300 S 460 275 500 260 S 610 242 720 156', score: '78',
  },
  fast: {
    title: 'The fast lane', subtitle: 'Main roads · fewer turns', mins: 16, distance: '3.6 km', exposure: 100, compared: 0, accent: 'orange', risk: 'Higher exposure',
    points: '0,0', path: 'M 78 314 C 130 250 214 276 260 215 S 330 188 390 188 S 456 115 534 126 S 625 150 720 156', score: '63',
  },
};

const NAV_ITEMS = [
  { id: 'planner', label: 'Route planner', icon: Route },
  { id: 'exposure', label: 'Exposure report', icon: Activity },
  { id: 'saved', label: 'Saved routes', icon: Bookmark },
];

function routeMinutes(kind: RouteKind, mode: Mode) {
  const times: Record<RouteKind, Record<Mode, number>> = {
    clean: { Cycle: 24, Walk: 62, Run: 32 },
    balanced: { Cycle: 19, Walk: 53, Run: 25 },
    fast: { Cycle: 16, Walk: 44, Run: 21 },
  };
  return times[kind][mode];
}

function aqiDescriptor(aqi: number) {
  if (aqi <= 50) return { label: 'Good', tone: 'good', hint: 'Air quality is considered satisfactory.' };
  if (aqi <= 100) return { label: 'Moderate', tone: 'moderate', hint: 'Sensitive groups may notice effects.' };
  if (aqi <= 150) return { label: 'Sensitive groups', tone: 'sensitive', hint: 'Sensitive people may experience effects.' };
  if (aqi <= 200) return { label: 'Unhealthy', tone: 'unhealthy', hint: 'Reduce prolonged outdoor exertion.' };
  if (aqi <= 300) return { label: 'Very unhealthy', tone: 'very-unhealthy', hint: 'Consider limiting outdoor activity.' };
  return { label: 'Hazardous', tone: 'hazardous', hint: 'Avoid outdoor exertion where possible.' };
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
    no2: Number(current.nitrogen_dioxide),
    ozone: Number(current.ozone),
    label: aqiDescriptor(aqi).label,
    source: 'live',
    observedAt: current.time ? new Date(current.time) : new Date(),
  };
}

function BrandMark() {
  return <div className="brand-mark" aria-label="Airpath"><span className="brand-symbol"><Wind size={18} strokeWidth={2.4} /></span><span>airpath<span className="brand-period">.</span></span></div>;
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
        <path d={ROUTES.fast.path} className={`map-route route-orange ${selected === 'fast' ? 'route-selected' : ''}`} transform="translate(0 0)" />
        <path d={ROUTES.balanced.path} className={`map-route route-blue ${selected === 'balanced' ? 'route-selected' : ''}`} transform="translate(0 0)" />
        <path d={ROUTES.clean.path} className={`map-route route-green ${selected === 'clean' ? 'route-selected' : ''}`} transform="translate(0 0)" />
        {selected === 'fast' && <path d={ROUTES.fast.path} className="route-glow orange-glow" />}
        {selected === 'balanced' && <path d={ROUTES.balanced.path} className="route-glow blue-glow" />}
        {selected === 'clean' && <path d={ROUTES.clean.path} className="route-glow green-glow" />}
        <g className="map-pin start-pin" transform="translate(78 314)"><circle r="18" className="pin-halo" /><circle r="11" className="pin-dot" /><circle r="4" fill="white" /></g>
        <g className="map-pin end-pin" transform="translate(720 156)"><circle r="20" className="pin-halo" /><circle r="12" className="pin-destination" /><path d="M-4 0 L-1 4 L5 -4" stroke="white" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" /></g>
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
      <div className="map-active-route"><div className={`route-icon-mini ${active.accent}`}><Leaf size={15} /></div><div><span className="active-route-label">SELECTED ROUTE</span><strong>{active.title}</strong></div><div className="route-score"><b>{active.score}</b><span>air score</span></div></div>
      <div className="map-disclaimer">Illustrative route geometry · not turn-by-turn navigation</div>
    </div>
  );
}

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

  useEffect(() => { void loadAir(CITIES[0]); // initial live reading
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const descriptor = aqiDescriptor(air.aqi);
  const activeRoute = ROUTES[selectedRoute];
  const routeIsSaved = savedRoutes.includes(`${origin}|${destination}|${selectedRoute}`);

  const selectedSubtitle = useMemo(() => {
    if (activeNav === 'exposure') return 'See what your lungs might be taking in along the way.';
    if (activeNav === 'saved') return 'Your quieter routes, ready when you are.';
    return 'Get there feeling better, not just faster.';
  }, [activeNav]);

  const planRoute = () => {
    setRouteReady(true);
    setActiveNav('planner');
  };

  const reverseRoute = () => {
    setOrigin(destination);
    setDestination(origin);
    setRouteReady(false);
  };

  const saveCurrentRoute = () => {
    const id = `${origin}|${destination}|${selectedRoute}`;
    setSavedRoutes((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setAirError('Location is not supported by this browser.'); return; }
    navigator.geolocation.getCurrentPosition(async (position) => {
      const target: City = { name: 'Your location', lat: position.coords.latitude, lon: position.coords.longitude, area: 'Approximate current location' };
      setCity(target);
      setAirLoading(true);
      setAirError('');
      try {
        const result = await fetchAir(target);
        setAir(result);
        setUpdatedText('just now');
      } catch {
        setAir(SAMPLE_AIR['New Delhi']);
        setAirError('Could not load local AQI; sample values are shown.');
      } finally { setAirLoading(false); }
    }, () => setAirError('Location permission was not granted. Choose a city instead.'), { timeout: 9000 });
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${showMobileMenu ? 'sidebar-open' : ''}`}>
        <div className="sidebar-top"><BrandMark /><button className="mobile-close" aria-label="Close menu" onClick={() => setShowMobileMenu(false)}><X size={19} /></button></div>
        <div className="workspace-switcher"><div className="workspace-avatar">A</div><div className="workspace-name"><strong>Airpath personal</strong><span>Free workspace</span></div><ChevronDown size={15} className="muted-icon" /></div>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="main-nav" aria-label="Main navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={`nav-item ${activeNav === item.id ? 'nav-active' : ''}`} onClick={() => { setActiveNav(item.id); setShowMobileMenu(false); }}><Icon size={18} strokeWidth={1.9} /><span>{item.label}</span>{item.id === 'saved' && savedRoutes.length > 0 && <span className="nav-count">{savedRoutes.length}</span>}</button>;
          })}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-caption">YOUR AIR</div>
        <button className="city-switcher" onClick={() => setShowCityMenu(!showCityMenu)}><span className="city-switch-icon"><MapPin size={16} /></span><span className="city-copy"><strong>{city.name}</strong><small>{city.area}</small></span><ChevronDown size={15} className="muted-icon" /></button>
        {showCityMenu && <div className="city-menu">{CITIES.map((option) => <button key={option.name} onClick={() => { setCity(option); setShowCityMenu(false); void loadAir(option); }}>{option.name}{city.name === option.name && <Check size={14} />}</button>)}</div>}
        <button className="sidebar-location" onClick={useMyLocation}><LocateFixed size={15} /> Use my location</button>
        <div className="sidebar-bottom">
          <div className="upgrade-card"><div className="upgrade-icon"><Sparkles size={17} /></div><strong>Make every trip count.</strong><p>Get weekly exposure insights and smarter commute tips.</p><button onClick={() => setActiveNav('exposure')}>Explore insights <ArrowRight size={14} /></button><div className="upgrade-shape shape-one" /><div className="upgrade-shape shape-two" /></div>
          <button className="nav-item help-link" onClick={() => window.alert('Airpath is a concept prototype. Air-quality readings use Open-Meteo when available; route geometry and exposure scores are illustrative demo data.')}><CircleHelp size={18} /><span>Help & about</span></button>
          <div className="profile-row"><div className="profile-avatar">BS</div><div className="profile-copy"><strong>Bhaumik</strong><span>Personal account</span></div><MoreHorizontal size={18} className="muted-icon" /></div>
        </div>
      </aside>

      {showMobileMenu && <button className="mobile-backdrop" aria-label="Close menu overlay" onClick={() => setShowMobileMenu(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="topbar-left"><button className="mobile-menu-button" aria-label="Open menu" onClick={() => setShowMobileMenu(true)}><Menu size={20} /></button><span className="breadcrumb">Workspace</span><span className="crumb-slash">/</span><span className="breadcrumb-current">{NAV_ITEMS.find((item) => item.id === activeNav)?.label ?? 'Route planner'}</span></div>
          <div className="topbar-right"><span className="live-status"><span className="live-dot" />{air.source === 'live' ? 'AQI feed connected' : 'Preview environment'}</span><button className="icon-button" aria-label="Refresh air quality" onClick={() => void loadAir()} disabled={airLoading}><RefreshCw size={17} className={airLoading ? 'spin' : ''} /></button><div className="top-avatar">BS</div></div>
        </header>

        <div className="page-content">
          <section className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" /> TRACK 01 <span className="eyebrow-separator">/</span> AIR</div><h1>{activeNav === 'exposure' ? 'Know what you breathe.' : activeNav === 'saved' ? 'Your saved escapes.' : 'Take the cleaner way.'}</h1><p>{selectedSubtitle}</p></div><div className="heading-date"><div className="date-glyph"><Compass size={17} /></div><div><span>YOUR COMMUTE, REIMAGINED</span><strong>Pollution-aware routing</strong></div></div></section>

          {activeNav === 'saved' ? (
            <section className="saved-page">
              <div className="section-title-row"><div><h2>Saved routes</h2><p>Your favorite lower-exposure trips.</p></div><span className="saved-total">{savedRoutes.length} saved</span></div>
              {savedRoutes.length === 0 ? <div className="empty-state"><div className="empty-icon"><Bookmark size={23} /></div><h3>Your next breath of fresh air starts here.</h3><p>Save a route from the planner and it will show up here for your next trip.</p><button className="primary-button" onClick={() => setActiveNav('planner')}>Plan a route <ArrowRight size={16} /></button></div> : <div className="saved-grid">{savedRoutes.map((item) => { const [from, to, kind] = item.split('|') as [string, string, RouteKind]; const route = ROUTES[kind]; return <article className="saved-card" key={item}><div className={`saved-card-icon ${route.accent}`}><Route size={18} /></div><span className="saved-pill">Saved</span><h3>{from} <ArrowRight size={15} /> {to}</h3><p>{route.title} · {route.distance} · {route.mins} min</p><div className="saved-card-bottom"><span><Leaf size={14} /> {route.risk}</span><button onClick={() => { setOrigin(from); setDestination(to); setSelectedRoute(kind); setActiveNav('planner'); }}>Open route <ArrowRight size={14} /></button></div></article>; })}</div>}
            </section>
          ) : activeNav === 'exposure' ? (
            <section className="exposure-page">
              <div className="section-title-row"><div><h2>Your exposure snapshot</h2><p>Current city reading plus an illustrative commute comparison.</p></div><button className="secondary-button" onClick={() => void loadAir()}><RefreshCw size={15} className={airLoading ? 'spin' : ''} /> Refresh data</button></div>
              <div className="exposure-kpis"><div className="exposure-kpi"><span>Current US AQI</span><strong>{air.aqi}</strong><em className={`status-text ${descriptor.tone}`}>{descriptor.label}</em></div><div className="exposure-kpi"><span>Estimated clean-route exposure</span><strong>−42%</strong><em>vs. fastest route</em></div><div className="exposure-kpi"><span>Route air score</span><strong>{activeRoute.score}<small>/100</small></strong><em>Selected: {activeRoute.title}</em></div></div>
              <div className="exposure-content-grid"><div className="panel pollutant-panel"><div className="panel-heading"><div><h3>What is in the air?</h3><p>Current reading · {city.name}</p></div><span className="panel-icon"><Wind size={17} /></span></div>{[{ name: 'PM2.5', value: air.pm25, unit: 'µg/m³', tag: 'Fine particles' }, { name: 'PM10', value: air.pm10, unit: 'µg/m³', tag: 'Coarse particles' }, { name: 'Nitrogen dioxide', value: air.no2, unit: 'µg/m³', tag: 'Traffic-related' }, { name: 'Ozone', value: air.ozone, unit: 'µg/m³', tag: 'Ground-level ozone' }].map((item, index) => <div className="pollutant-row" key={item.name}><div className={`pollutant-symbol p-${index}`}><Activity size={15} /></div><div className="pollutant-name"><strong>{item.name}</strong><span>{item.tag}</span></div><div className="pollutant-value"><strong>{Number.isFinite(item.value) ? item.value.toFixed(1) : '—'}</strong><span>{item.unit}</span></div><div className="pollutant-bar"><i style={{ width: `${Math.min(100, Math.max(4, item.value / (index === 0 ? 75 : index === 1 ? 120 : 80) * 100))}%` }} /></div></div>)}<div className="data-footnote"><ShieldCheck size={14} /> {air.source === 'live' ? 'Air quality from Open-Meteo · indicative location-level data' : 'Sample readings · live air-quality feed could not be reached'}</div></div>
                <div className="panel insight-panel"><div className="insight-orb"><Leaf size={25} /></div><span className="insight-label">YOUR CLEANER COMMUTE</span><h3>Small detours.<br />A meaningful difference.</h3><p>Choosing a route away from high-traffic corridors may reduce your exposure to traffic-related pollutants. Actual exposure depends on weather, time, exertion, and street-level conditions.</p><div className="insight-stat"><span>Route exposure estimate</span><strong>−42%</strong></div><div className="insight-divider" /><div className="insight-stat"><span>Additional travel time</span><strong>+8 min</strong></div><button className="primary-button full-width" onClick={() => setActiveNav('planner')}>Compare routes <ArrowRight size={16} /></button><div className="insight-note">Demo estimate — not a measured personal dose.</div></div></div>
            </section>
          ) : (
            <>
              <section className="route-search panel"><div className="search-label"><div className="search-label-icon"><Navigation size={16} /></div><span>PLAN YOUR JOURNEY</span><span className="search-demo">Prototype</span></div><div className="search-controls"><div className="location-fields"><label className="location-input origin-field"><span className="location-marker origin-marker" /><span className="input-caption">FROM</span><input aria-label="Starting location" value={origin} onChange={(event) => { setOrigin(event.target.value); setRouteReady(false); }} onKeyDown={(event) => event.key === 'Enter' && planRoute()} placeholder="Choose start point" /></label><button className="swap-button" aria-label="Swap origin and destination" onClick={reverseRoute}><ArrowDownUp size={16} /></button><label className="location-input destination-field"><span className="location-marker destination-marker" /><span className="input-caption">TO</span><input aria-label="Destination" value={destination} onChange={(event) => { setDestination(event.target.value); setRouteReady(false); }} onKeyDown={(event) => event.key === 'Enter' && planRoute()} placeholder="Where to?" /></label></div><button className="primary-button plan-button" onClick={planRoute} disabled={!origin.trim() || !destination.trim()}><Search size={16} /> Find my route</button></div><div className="search-bottom"><div className="mode-picker"><span>GETTING THERE BY</span><button className={mode === 'Cycle' ? 'mode-active' : ''} onClick={() => setMode('Cycle')}><Bike size={16} /> Cycle</button><button className={mode === 'Walk' ? 'mode-active' : ''} onClick={() => setMode('Walk')}><Footprints size={16} /> Walk</button><button className={mode === 'Run' ? 'mode-active' : ''} onClick={() => setMode('Run')}><Activity size={16} /> Run</button></div><div className="avoid-setting"><span className="avoid-check"><Check size={12} /></span><span>Avoid high-pollution zones</span><span className="setting-tag">ON</span></div></div>{!routeReady && <div className="route-edit-note">Route endpoints updated. Select “Find my route” to refresh this preview.</div>}</section>

              {airError && <div className="live-warning"><Wind size={14} /><span>{airError}</span></div>}

              <section className="overview-row"><div className="overview-title"><span className="section-kicker">ROUTE OVERVIEW</span><h2>Pick your kind of better.</h2><p>Compare time against estimated pollution exposure.</p></div><div className="air-quality-card"><div className={`aqi-ring ${descriptor.tone}`}><span className="aqi-ring-inner"><Wind size={16} /></span></div><div className="aqi-details"><span className="aqi-heading">AIR QUALITY <span className={`aqi-bullet ${descriptor.tone}`} /></span><div className="aqi-number-row"><strong>{air.aqi}</strong><span className={`aqi-status ${descriptor.tone}`}>{descriptor.label}</span></div><span className="aqi-location"><MapPin size={12} /> {city.name} · US AQI</span></div><button className="aqi-refresh" onClick={() => void loadAir()} title="Refresh air quality" aria-label="Refresh air quality" disabled={airLoading}><RefreshCw size={15} className={airLoading ? 'spin' : ''} /></button></div></section>

              <section className="route-layout"><div className="route-options-column"><div className="routes-heading"><div><h3>Suggested routes <span className="route-count">03</span></h3><p>For your {mode.toLowerCase()} commute</p></div><button className="filter-button" onClick={() => setSelectedRoute(selectedRoute === 'clean' ? 'balanced' : selectedRoute === 'balanced' ? 'fast' : 'clean')}><ArrowRight size={14} /> Next route</button></div><div className="route-cards">
                <button className={`route-card ${selectedRoute === 'clean' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('clean')}><div className="route-card-top"><div className="route-card-icon clean-icon"><Leaf size={17} /></div><span className="recommended-label"><Sparkles size={12} /> RECOMMENDED</span></div><div className="route-card-title"><h4>The greener way</h4>{selectedRoute === 'clean' && <span className="selected-check"><Check size={12} /></span>}</div><p className="route-card-subtitle">Park paths · quieter streets</p><div className="route-card-metrics"><div><Clock3 size={14} /><strong>{routeMinutes('clean', mode)} <small>min</small></strong></div><span className="metric-divider" /><div><Route size={14} /><strong>4.8 <small>km</small></strong></div></div><div className="exposure-line"><span>Pollution exposure</span><strong className="low-text">Low</strong></div><div className="exposure-track"><span style={{ width: '38%' }} /></div><div className="route-card-footer"><span><Leaf size={13} /> 42% less exposure</span><span className="score-chip score-green">92 <small>/ 100</small></span></div></button>
                <button className={`route-card ${selectedRoute === 'balanced' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('balanced')}><div className="route-card-top"><div className="route-card-icon balanced-icon"><Compass size={17} /></div><span className="option-label">BALANCED</span></div><div className="route-card-title"><h4>The balanced route</h4>{selectedRoute === 'balanced' && <span className="selected-check"><Check size={12} /></span>}</div><p className="route-card-subtitle">A little of both</p><div className="route-card-metrics"><div><Clock3 size={14} /><strong>{routeMinutes('balanced', mode)} <small>min</small></strong></div><span className="metric-divider" /><div><Route size={14} /><strong>4.1 <small>km</small></strong></div></div><div className="exposure-line"><span>Pollution exposure</span><strong className="medium-text">Moderate</strong></div><div className="exposure-track"><span style={{ width: '61%' }} /></div><div className="route-card-footer"><span><Activity size={13} /> 18% less exposure</span><span className="score-chip score-blue">78 <small>/ 100</small></span></div></button>
                <button className={`route-card ${selectedRoute === 'fast' ? 'route-card-selected' : ''}`} onClick={() => setSelectedRoute('fast')}><div className="route-card-top"><div className="route-card-icon fast-icon"><ArrowUpRight size={17} /></div><span className="option-label">FASTEST</span></div><div className="route-card-title"><h4>The fast lane</h4>{selectedRoute === 'fast' && <span className="selected-check"><Check size={12} /></span>}</div><p className="route-card-subtitle">Main roads · fewer turns</p><div className="route-card-metrics"><div><Clock3 size={14} /><strong>{routeMinutes('fast', mode)} <small>min</small></strong></div><span className="metric-divider" /><div><Route size={14} /><strong>3.6 <small>km</small></strong></div></div><div className="exposure-line"><span>Pollution exposure</span><strong className="high-text">Higher</strong></div><div className="exposure-track"><span style={{ width: '100%' }} /></div><div className="route-card-footer"><span><Activity size={13} /> Baseline exposure</span><span className="score-chip score-orange">63 <small>/ 100</small></span></div></button>
              </div><div className="route-note"><ShieldCheck size={16} /><p><strong>Your lungs, your call.</strong> Choose the balance that feels right today. All exposure values are illustrative prototype estimates.</p></div></div>

                <div className="map-column"><div className="map-heading"><div><h3>Route preview</h3><p><span className="map-live-dot" /> {city.name} <span className="dot-separator">·</span> Air-aware map</p></div><button className={`save-route-button ${routeIsSaved ? 'saved' : ''}`} onClick={saveCurrentRoute}><Bookmark size={15} fill={routeIsSaved ? 'currentColor' : 'none'} /> {routeIsSaved ? 'Saved' : 'Save route'}</button></div><CityMap selected={selectedRoute} city={city} origin={origin || 'Start'} destination={destination || 'Destination'} /><div className="route-detail-strip"><div className="route-detail-main"><span className="detail-icon"><Gauge size={17} /></span><div><span>YOUR PICK</span><strong>{activeRoute.title}</strong></div></div><div className="detail-stat"><span>ETA</span><strong>{routeMinutes(selectedRoute, mode)} min</strong></div><div className="detail-stat"><span>EXPOSURE</span><strong className={`${selectedRoute === 'clean' ? 'low-text' : selectedRoute === 'balanced' ? 'medium-text' : 'high-text'}`}>{selectedRoute === 'clean' ? 'Low' : selectedRoute === 'balanced' ? 'Medium' : 'Higher'}</strong></div><button className="detail-go-button" onClick={() => window.alert('Navigation is not connected in this concept prototype. The live product would hand off the selected route to a navigation provider.')} aria-label="Start navigation"><ArrowRight size={18} /></button></div><div className="map-data-note"><span className={`data-status-dot ${air.source}`} /><span>{air.source === 'live' ? `Live city-level AQI · Open-Meteo` : 'Sample air-quality data'} <span className="dot-separator">·</span> updated {updatedText}</span><button onClick={() => setActiveNav('exposure')}>View report <ArrowRight size={12} /></button></div></div></section>

              <section className="bottom-insight-row"><div className="insight-banner"><div className="insight-banner-icon"><Sparkles size={19} /></div><div className="banner-copy"><span>A LITTLE AIRPATH INSIGHT</span><strong>Traffic isn’t the only thing worth avoiding.</strong><p>Even a few quieter blocks can make a difference. Check your route just before you leave.</p></div><button onClick={() => setActiveNav('exposure')}>Explore air insights <ArrowRight size={15} /></button><div className="banner-decoration"><div /><div /><div /></div></div><div className="daily-air-card"><div className="daily-air-top"><span>THE AIR, RIGHT NOW</span><span className="daily-wind"><Wind size={17} /></span></div><div className="daily-aqi-line"><strong>{air.aqi}</strong><div><span className={`mini-status ${descriptor.tone}`}>{descriptor.label}</span><small>US AQI · {city.name}</small></div></div><div className="aqi-scale"><span /><span /><span /><span /><span /><span /></div><div className="scale-labels"><span>Good</span><span>Hazardous</span></div><div className="daily-card-footer"><span>{air.source === 'live' ? 'Live reading' : 'Sample reading'}</span><button onClick={() => void loadAir()}>Update <RefreshCw size={12} /></button></div></div></section>
              </>
          )}

          <footer className="page-footer"><span>© 2026 Airpath · Track 01: Air</span><span><span className="footer-dot" /> Built for better breaths</span><a href="https://open-meteo.com/en/docs/air-quality-api" target="_blank" rel="noreferrer">Air data by Open-Meteo <ArrowUpRight size={12} /></a></footer>
        </div>
      </main>
    </div>
  );
}

export default App;
