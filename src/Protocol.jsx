import React, { useState, useEffect, useRef } from 'react';
import { Camera, TrendingDown, Activity, Settings, Plus, Trash2, Upload, Loader2, Check, X, ChevronRight, Flame, Beef, Wheat, Droplet, Edit3, BarChart3, Bookmark, Star, Zap, Scale, TrendingUp, Type, Copy } from 'lucide-react';

// ============ STORAGE HELPERS (localStorage) ============
const PREFIX = 'protocol:';
const storage = {
  async get(key) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v ? JSON.parse(v) : null;
    } catch { return null; }
  },
  async set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch (e) { console.error(e); }
  },
  async list(prefix) {
    try {
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(PREFIX + prefix)) keys.push(k.slice(PREFIX.length));
      }
      return keys;
    } catch { return []; }
  },
  async delete(key) {
    try { localStorage.removeItem(PREFIX + key); } catch (e) { console.error(e); }
  }
};

const todayKey = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

// ============ CALORIE MATH ============
// Recovery-aware deficit: green = full deficit, yellow = reduced, red = maintenance
// When Whoop calorie burn is available, use that as TDEE (it already accounts for strain).
// Otherwise fall back to static maintenance + strain bump.
function computeTarget(profile, recovery, strain, whoopBurn) {
  if (!profile?.maintenance && !whoopBurn) return { calories: 2400, protein: 180, deficit: 0, strainBump: 0, source: 'default' };

  const baseDeficit = profile?.deficit || 350;
  let actualDeficit = baseDeficit;
  if (recovery === 'yellow') actualDeficit = baseDeficit * 0.4;
  if (recovery === 'red') actualDeficit = 0;

  let tdee, source, strainBump = 0;
  if (whoopBurn && whoopBurn > 1000) {
    // Use Whoop's actual energy expenditure
    tdee = whoopBurn;
    source = 'whoop';
  } else {
    // Fall back to static maintenance + strain estimate
    tdee = profile.maintenance;
    source = 'static';
    if (strain >= 17) strainBump = 350;
    else if (strain >= 14) strainBump = 200;
    else if (strain >= 11) strainBump = 100;
    tdee += strainBump;
  }

  const calories = Math.round(tdee - actualDeficit);
  const protein = Math.round((profile?.weightLbs || 180) * 1.0);
  return {
    calories,
    protein,
    deficit: Math.round(actualDeficit),
    strainBump,
    tdee: Math.round(tdee),
    source,
  };
}

// ============ PHOTO ANALYSIS via serverless function ============
async function analyzeFoodPhoto(base64, mimeType) {
  const response = await fetch("/api/analyze-meal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ base64, mimeType })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API error: ${response.status} ${errText}`);
  }
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data;
}

// ============ WHOOP CSV PARSER ============
function parseWhoopCSV(text) {
  const lines = text.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, '').toLowerCase());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
    const row = {};
    headers.forEach((h, idx) => row[h] = vals[idx]);
    rows.push(row);
  }
  return rows.map(r => {
    const dateStr = r['cycle start time'] || r['date'] || r['day'] || r['cycle start'] || '';
    const recovery = parseFloat(r['recovery score %'] || r['recovery'] || r['recovery score'] || '');
    const hrv = parseFloat(r['heart rate variability (ms)'] || r['hrv'] || r['hrv (ms)'] || '');
    const rhr = parseFloat(r['resting heart rate (bpm)'] || r['rhr'] || r['resting hr'] || '');
    const strain = parseFloat(r['day strain'] || r['strain'] || '');
    const sleep = parseFloat(r['asleep duration (min)'] || r['sleep'] || '') / 60;
    // Whoop reports calories as "Energy burned (cal)" but the value is actually kcal
    const burn = parseFloat(r['energy burned (cal)'] || r['energy burned (kcal)'] || r['calories burned'] || r['energy burned'] || r['calories'] || '');
    let date = '';
    try { date = new Date(dateStr).toISOString().slice(0, 10); } catch {}
    return { date, recovery, hrv, rhr, strain, sleep, burn };
  }).filter(r => r.date && !isNaN(r.recovery));
}

function recoveryBand(score) {
  if (score >= 67) return 'green';
  if (score >= 34) return 'yellow';
  return 'red';
}

// ============ GOOGLE SHEET SYNC ============
// Converts a Google Sheets share URL to its published CSV export URL
function sheetUrlToCsv(url) {
  if (!url) return null;
  if (url.includes('/export?format=csv') || url.includes('output=csv')) return url;
  const idMatch = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!idMatch) return null;
  const id = idMatch[1];
  const gidMatch = url.match(/[#&?]gid=([0-9]+)/);
  const gid = gidMatch ? gidMatch[1] : '0';
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

async function fetchSheetData(sheetUrl) {
  const csvUrl = sheetUrlToCsv(sheetUrl);
  if (!csvUrl) throw new Error('Invalid Sheet URL');
  const res = await fetch(csvUrl);
  if (!res.ok) throw new Error(`Sheet not accessible (${res.status}). Make sure it's shared as "Anyone with link can view".`);
  const text = await res.text();
  return parseWhoopCSV(text);
}

// ============ WHOOP OAUTH SYNC ============
async function fetchWhoopStatus() {
  try {
    const r = await fetch('/api/whoop/status', { credentials: 'same-origin' });
    if (!r.ok) return { connected: false };
    return r.json();
  } catch { return { connected: false }; }
}

async function fetchWhoopSync(days = 30) {
  const r = await fetch(`/api/whoop/sync?days=${days}`, { credentials: 'same-origin' });
  if (r.status === 401) throw new Error('not_connected');
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`sync failed: ${r.status} ${txt}`);
  }
  return r.json();
}

async function disconnectWhoop() {
  try {
    await fetch('/api/whoop/disconnect', { method: 'POST', credentials: 'same-origin' });
  } catch {}
}

// ============ MAIN APP ============
export default function App() {
  const [tab, setTab] = useState('today');
  const [profile, setProfile] = useState(null);
  const [meals, setMeals] = useState([]);
  const [scans, setScans] = useState([]);
  const [whoop, setWhoop] = useState([]);
  const [savedMeals, setSavedMeals] = useState([]);
  const [weights, setWeights] = useState([]);
  const [sheetUrl, setSheetUrl] = useState('');
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [whoopConnected, setWhoopConnected] = useState(false);
  const [whoopBanner, setWhoopBanner] = useState(null); // {type:'success'|'error', text}
  const [loaded, setLoaded] = useState(false);

  // Merge incoming sheet rows with existing whoop data (sheet wins per-date)
  const mergeWhoopRows = async (rows) => {
    setWhoop(prev => {
      const merged = [...prev];
      for (const r of rows) {
        const idx = merged.findIndex(x => x.date === r.date);
        if (idx >= 0) merged[idx] = r; else merged.push(r);
      }
      merged.sort((a, b) => a.date.localeCompare(b.date));
      storage.set('whoop', merged);
      return merged;
    });
  };

  // Auto-sync from sheet
  const syncSheet = async (url) => {
    const targetUrl = url ?? sheetUrl;
    if (!targetUrl) return { ok: false, msg: 'No Sheet connected' };
    setSyncing(true);
    try {
      const rows = await fetchSheetData(targetUrl);
      if (rows.length === 0) {
        setSyncing(false);
        return { ok: false, msg: 'Sheet had no valid recovery rows' };
      }
      await mergeWhoopRows(rows);
      const now = Date.now();
      setLastSync(now);
      await storage.set('lastSync', now);
      setSyncing(false);
      return { ok: true, msg: `Synced ${rows.length} day${rows.length === 1 ? '' : 's'}` };
    } catch (e) {
      setSyncing(false);
      return { ok: false, msg: e.message || 'Sync failed' };
    }
  };

  // Sync via Whoop OAuth
  const syncWhoopOAuth = async () => {
    setSyncing(true);
    try {
      const { rows } = await fetchWhoopSync(30);
      if (!rows || rows.length === 0) {
        setSyncing(false);
        return { ok: false, msg: 'No recovery data returned from Whoop' };
      }
      await mergeWhoopRows(rows);
      const now = Date.now();
      setLastSync(now);
      await storage.set('lastSync', now);
      setSyncing(false);
      return { ok: true, msg: `Synced ${rows.length} day${rows.length === 1 ? '' : 's'} from Whoop` };
    } catch (e) {
      setSyncing(false);
      if (e.message === 'not_connected') {
        setWhoopConnected(false);
        return { ok: false, msg: 'Not connected to Whoop. Tap Connect.' };
      }
      return { ok: false, msg: e.message || 'Sync failed' };
    }
  };

  // Handler called from RecoveryView for OAuth disconnect
  const handleWhoopDisconnect = async () => {
    await disconnectWhoop();
    setWhoopConnected(false);
    setWhoopBanner({ type: 'success', text: 'Disconnected from Whoop' });
    setTimeout(() => setWhoopBanner(null), 3000);
  };

  useEffect(() => {
    (async () => {
      const p = await storage.get('profile');
      setProfile(p);
      const w = await storage.get('whoop') || [];
      setWhoop(w);
      const s = await storage.get('scans') || [];
      setScans(s);
      const sm = await storage.get('savedMeals') || [];
      setSavedMeals(sm);
      const wt = await storage.get('weights') || [];
      setWeights(wt);
      const su = await storage.get('sheetUrl') || '';
      setSheetUrl(su);
      const ls = await storage.get('lastSync');
      setLastSync(ls);
      const mealKeys = await storage.list('meal:');
      const ms = [];
      for (const k of mealKeys) {
        const m = await storage.get(k);
        if (m) ms.push({ ...m, _key: k });
      }
      setMeals(ms.sort((a, b) => b.timestamp - a.timestamp));
      setLoaded(true);

      // Check Whoop OAuth connection status
      const status = await fetchWhoopStatus();
      setWhoopConnected(!!status.connected);

      // Handle OAuth redirect result from Whoop callback
      try {
        const params = new URLSearchParams(window.location.search);
        const whoopFlag = params.get('whoop');
        if (whoopFlag === 'connected') {
          setWhoopConnected(true);
          setWhoopBanner({ type: 'success', text: 'Connected to Whoop. Pulling your data…' });
          // Strip query params from URL without reload
          window.history.replaceState({}, document.title, window.location.pathname);
          // Immediately sync
          try {
            const { rows } = await fetchWhoopSync(30);
            if (rows && rows.length > 0) {
              const merged = [...w];
              for (const r of rows) {
                const idx = merged.findIndex(x => x.date === r.date);
                if (idx >= 0) merged[idx] = r; else merged.push(r);
              }
              merged.sort((a, b) => a.date.localeCompare(b.date));
              await storage.set('whoop', merged);
              setWhoop(merged);
              const now = Date.now();
              setLastSync(now);
              await storage.set('lastSync', now);
              setWhoopBanner({ type: 'success', text: `Pulled ${rows.length} days from Whoop ✓` });
              setTimeout(() => setWhoopBanner(null), 4000);
            }
          } catch (e) {
            setWhoopBanner({ type: 'error', text: 'Connected, but initial sync failed. Try syncing manually.' });
            setTimeout(() => setWhoopBanner(null), 5000);
          }
        } else if (whoopFlag === 'error') {
          const reason = params.get('reason') || 'unknown';
          setWhoopBanner({ type: 'error', text: `Whoop connect failed: ${reason}` });
          setTimeout(() => setWhoopBanner(null), 5000);
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      } catch (e) { console.warn('OAuth redirect check:', e); }

      // Auto-sync via OAuth if connected and >1hr since last sync
      if (status.connected && (!ls || Date.now() - ls > 60 * 60 * 1000)) {
        try {
          const { rows } = await fetchWhoopSync(30);
          if (rows && rows.length > 0) {
            const merged = [...w];
            for (const r of rows) {
              const idx = merged.findIndex(x => x.date === r.date);
              if (idx >= 0) merged[idx] = r; else merged.push(r);
            }
            merged.sort((a, b) => a.date.localeCompare(b.date));
            await storage.set('whoop', merged);
            setWhoop(merged);
            const now = Date.now();
            setLastSync(now);
            await storage.set('lastSync', now);
          }
        } catch (e) {
          if (e.message === 'not_connected') setWhoopConnected(false);
        }
      }

      // Auto-sync if we have a sheet URL and last sync was >1hr ago
      if (su && (!ls || Date.now() - ls > 60 * 60 * 1000)) {
        try {
          const rows = await fetchSheetData(su);
          if (rows.length > 0) {
            const merged = [...w];
            for (const r of rows) {
              const idx = merged.findIndex(x => x.date === r.date);
              if (idx >= 0) merged[idx] = r; else merged.push(r);
            }
            merged.sort((a, b) => a.date.localeCompare(b.date));
            await storage.set('whoop', merged);
            setWhoop(merged);
            const now = Date.now();
            setLastSync(now);
            await storage.set('lastSync', now);
          }
        } catch (e) {
          console.warn('Background sync failed:', e.message);
        }
      }
    })();
  }, []);

  const today = todayKey();
  const todayMeals = meals.filter(m => m.date === today);
  const todayWhoop = whoop.find(w => w.date === today) || whoop.sort((a,b) => b.date.localeCompare(a.date))[0];
  const recoveryBandToday = todayWhoop ? recoveryBand(todayWhoop.recovery) : 'green';
  const todayStrain = todayWhoop?.strain || 0;
  const todayBurn = todayWhoop?.burn || null;
  const target = computeTarget(profile, recoveryBandToday, todayStrain, todayBurn);

  const consumed = todayMeals.reduce((acc, m) => ({
    calories: acc.calories + (m.calories || 0),
    protein: acc.protein + (m.protein || 0),
    carbs: acc.carbs + (m.carbs || 0),
    fat: acc.fat + (m.fat || 0),
  }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

  if (!loaded) {
    return <div style={S.loadingScreen}><Loader2 size={24} style={{animation: 'spin 1s linear infinite', color: 'var(--accent)'}} /></div>;
  }

  if (!profile) {
    return <Onboarding onSave={async (p) => { await storage.set('profile', p); setProfile(p); }} />;
  }

  // Helper to add a meal
  const addMeal = async (meal) => {
    const key = `meal:${Date.now()}`;
    const m = { ...meal, date: today, timestamp: Date.now() };
    await storage.set(key, m);
    setMeals([{ ...m, _key: key }, ...meals]);
  };

  // Helper to save a meal to library
  const saveMealToLibrary = async (meal) => {
    const entry = {
      id: `sm_${Date.now()}`,
      name: meal.name,
      calories: meal.calories,
      protein: meal.protein,
      carbs: meal.carbs,
      fat: meal.fat,
      created: Date.now(),
      uses: 0,
    };
    const next = [...savedMeals, entry];
    await storage.set('savedMeals', next);
    setSavedMeals(next);
  };

  return (
    <div style={S.app}>
      <Header />
      <div style={S.viewWrap}>
        {tab === 'today' && (
          <TodayView
            target={target}
            consumed={consumed}
            meals={todayMeals}
            whoop={todayWhoop}
            recoveryBand={recoveryBandToday}
            savedMeals={savedMeals}
            weights={weights}
            profile={profile}
            onAddMeal={addMeal}
            onSaveMeal={saveMealToLibrary}
            onDeleteSaved={async (id) => {
              const next = savedMeals.filter(s => s.id !== id);
              await storage.set('savedMeals', next);
              setSavedMeals(next);
            }}
            onIncrementSavedUse={async (id) => {
              const next = savedMeals.map(s => s.id === id ? { ...s, uses: (s.uses || 0) + 1 } : s);
              await storage.set('savedMeals', next);
              setSavedMeals(next);
            }}
            onDeleteMeal={async (m) => {
              await storage.delete(m._key);
              setMeals(meals.filter(x => x._key !== m._key));
            }}
            onLogWeight={async (w) => {
              const next = [...weights.filter(x => x.date !== w.date), w].sort((a, b) => a.date.localeCompare(b.date));
              await storage.set('weights', next);
              setWeights(next);
            }}
          />
        )}
        {tab === 'insights' && (
          <InsightsView
            meals={meals}
            weights={weights}
            scans={scans}
            whoop={whoop}
            profile={profile}
          />
        )}
        {tab === 'body' && (
          <BodyView
            scans={scans}
            weights={weights}
            onAddScan={async (s) => {
              const next = [...scans, s].sort((a, b) => a.date.localeCompare(b.date));
              await storage.set('scans', next);
              setScans(next);
            }}
            onDeleteScan={async (idx) => {
              const next = scans.filter((_, i) => i !== idx);
              await storage.set('scans', next);
              setScans(next);
            }}
            onLogWeight={async (w) => {
              const next = [...weights.filter(x => x.date !== w.date), w].sort((a, b) => a.date.localeCompare(b.date));
              await storage.set('weights', next);
              setWeights(next);
            }}
            onDeleteWeight={async (date) => {
              const next = weights.filter(w => w.date !== date);
              await storage.set('weights', next);
              setWeights(next);
            }}
          />
        )}
        {tab === 'recovery' && (
          <RecoveryView
            whoop={whoop}
            sheetUrl={sheetUrl}
            lastSync={lastSync}
            syncing={syncing}
            whoopConnected={whoopConnected}
            whoopBanner={whoopBanner}
            onSyncWhoopOAuth={syncWhoopOAuth}
            onDisconnectWhoop={handleWhoopDisconnect}
            onSaveSheetUrl={async (url) => {
              setSheetUrl(url);
              await storage.set('sheetUrl', url);
              if (url) {
                return await syncSheet(url);
              }
              return { ok: true, msg: 'Sheet disconnected' };
            }}
            onSync={() => syncSheet()}
            onImport={async (rows) => {
              const merged = [...whoop];
              for (const r of rows) {
                const idx = merged.findIndex(x => x.date === r.date);
                if (idx >= 0) merged[idx] = r; else merged.push(r);
              }
              merged.sort((a, b) => a.date.localeCompare(b.date));
              await storage.set('whoop', merged);
              setWhoop(merged);
            }}
            onClear={async () => {
              await storage.set('whoop', []);
              setWhoop([]);
            }}
          />
        )}
        {tab === 'settings' && (
          <SettingsView
            profile={profile}
            savedMeals={savedMeals}
            onSave={async (p) => { await storage.set('profile', p); setProfile(p); }}
            onDeleteSaved={async (id) => {
              const next = savedMeals.filter(s => s.id !== id);
              await storage.set('savedMeals', next);
              setSavedMeals(next);
            }}
          />
        )}
      </div>
      <TabBar tab={tab} setTab={setTab} />
      <GlobalStyles />
    </div>
  );
}

// ============ HEADER ============
function Header() {
  const d = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return (
    <div style={S.header}>
      <div style={S.headerRow}>
        <div style={S.brand}>protocol<span style={{color: 'var(--accent)', fontStyle: 'italic'}}>.</span></div>
        <div style={S.datePill}>{d}</div>
      </div>
    </div>
  );
}

// ============ TAB BAR ============
function TabBar({ tab, setTab }) {
  const tabs = [
    { id: 'today', label: 'Today', Icon: Flame },
    { id: 'insights', label: 'Trends', Icon: BarChart3 },
    { id: 'body', label: 'Body', Icon: TrendingDown },
    { id: 'recovery', label: 'Whoop', Icon: Activity },
    { id: 'settings', label: 'Setup', Icon: Settings },
  ];
  return (
    <div style={S.tabBar}>
      {tabs.map(({ id, label, Icon }) => (
        <button key={id} onClick={() => setTab(id)} style={{...S.tab, color: tab === id ? 'var(--accent)' : 'var(--text-faint)'}}>
          <Icon size={17} strokeWidth={1.75} />
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}

// ============ ONBOARDING ============
// Goal plan presets — each defines a deficit and what it's optimized for
const GOAL_PLANS = [
  {
    id: 'recomp',
    label: 'Recomp',
    deficit: 100,
    weeklyLoss: 0.2,
    blurb: 'Slow lean-out. Prioritize strength and lifting gains. Best if you have time and want zero performance compromise.',
  },
  {
    id: 'steady',
    label: 'Steady cut',
    deficit: 350,
    weeklyLoss: 0.7,
    blurb: 'The sustainable middle ground. Recommended for athletes leaning out without losing strength or compromising training.',
    recommended: true,
  },
  {
    id: 'aggressive',
    label: 'Aggressive cut',
    deficit: 600,
    weeklyLoss: 1.2,
    blurb: 'Faster timeline. Higher risk to lean mass. Use only short-term and watch HRV closely.',
  },
  {
    id: 'maintain',
    label: 'Maintain',
    deficit: 0,
    weeklyLoss: 0,
    blurb: 'Hold current body comp. Fuel performance. Use during heavy training blocks, taper weeks, or competition.',
  },
];

function Onboarding({ onSave }) {
  const [step, setStep] = useState(1); // 1: weight, 2: whoop, 3: plan
  const [weight, setWeight] = useState('');
  const [whoopConnected, setWhoopConnected] = useState(false);
  const [whoopBurn, setWhoopBurn] = useState(null); // avg from last 7 days
  const [manualMaintenance, setManualMaintenance] = useState('');
  const [selectedPlan, setSelectedPlan] = useState('steady');
  const [checking, setChecking] = useState(false);

  // On mount and when returning from OAuth, check connection status
  useEffect(() => {
    (async () => {
      setChecking(true);
      const status = await fetchWhoopStatus();
      setWhoopConnected(!!status.connected);

      // Handle OAuth redirect during onboarding
      const params = new URLSearchParams(window.location.search);
      const whoopFlag = params.get('whoop');
      if (whoopFlag === 'connected') {
        setWhoopConnected(true);
        window.history.replaceState({}, document.title, window.location.pathname);
        setStep(2); // make sure we're on the Whoop step
      }

      // If connected, fetch recent burn to auto-suggest maintenance
      if (status.connected) {
        try {
          const { rows } = await fetchWhoopSync(7);
          const burns = (rows || []).map(r => r.burn).filter(b => b && b > 1000);
          if (burns.length > 0) {
            const avg = burns.reduce((s, b) => s + b, 0) / burns.length;
            setWhoopBurn(Math.round(avg));
          }
        } catch {}
      }
      setChecking(false);
    })();
  }, []);

  const handleFinish = () => {
    const plan = GOAL_PLANS.find(p => p.id === selectedPlan) || GOAL_PLANS[1];
    const maintenance = whoopBurn || parseFloat(manualMaintenance) || (parseFloat(weight) * 16);
    onSave({
      weightLbs: parseFloat(weight),
      maintenance,
      deficit: plan.deficit,
      planId: plan.id,
    });
  };

  return (
    <div style={S.app}>
      <div style={{padding: '60px 24px 40px'}}>
        <div style={{...S.brand, fontSize: 28, marginBottom: 8}}>protocol<span style={{color: 'var(--accent)', fontStyle: 'italic'}}>.</span></div>
        <div style={{color: 'var(--text-dim)', fontSize: 14, marginBottom: 8}}>Lean phase tracking, recovery-aware.</div>

        {/* Step indicator */}
        <div style={{display: 'flex', gap: 6, marginBottom: 32, marginTop: 24}}>
          {[1, 2, 3].map(n => (
            <div key={n} style={{
              flex: 1, height: 3, borderRadius: 2,
              background: step >= n ? 'var(--accent)' : 'var(--line-bright)',
              transition: 'background 0.2s',
            }} />
          ))}
        </div>

        {/* STEP 1: Weight */}
        {step === 1 && (
          <>
            <div style={{fontFamily: 'var(--display)', fontSize: 26, fontWeight: 400, fontStyle: 'italic', marginBottom: 8, letterSpacing: '-0.02em'}}>
              What's your weight?
            </div>
            <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 28, lineHeight: 1.5}}>
              Used for your protein target (1g per lb to protect lean mass while cutting).
            </div>

            <div style={{marginBottom: 28}}>
              <label style={S.fieldLabel}>Body weight</label>
              <div style={S.inputWrap}>
                <input style={S.input} type="number" inputMode="decimal" value={weight} onChange={e => setWeight(e.target.value)} placeholder="180" autoFocus />
                <span style={S.inputSuffix}>lbs</span>
              </div>
            </div>

            <button
              style={{...S.primaryBtn, width: '100%', opacity: weight ? 1 : 0.4}}
              disabled={!weight}
              onClick={() => setStep(2)}
            >
              Continue <ChevronRight size={18} />
            </button>
          </>
        )}

        {/* STEP 2: Whoop */}
        {step === 2 && (
          <>
            <div style={{fontFamily: 'var(--display)', fontSize: 26, fontWeight: 400, fontStyle: 'italic', marginBottom: 8, letterSpacing: '-0.02em'}}>
              Connect Whoop
            </div>
            <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 28, lineHeight: 1.5}}>
              Whoop tells us your actual daily energy burn, so your target adjusts to what you actually trained. Without it, we estimate.
            </div>

            {checking ? (
              <div style={{textAlign: 'center', padding: 40}}>
                <Loader2 size={20} style={{animation: 'spin 1s linear infinite', color: 'var(--accent)'}} />
              </div>
            ) : whoopConnected ? (
              <>
                <div style={{...S.targetCard, padding: '18px 20px', marginBottom: 16}}>
                  <div style={S.targetCardGlow} />
                  <div style={{position: 'relative', zIndex: 1}}>
                    <div style={{fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em', color: 'var(--accent)', textTransform: 'uppercase', fontWeight: 600, marginBottom: 6}}>
                      ● Connected
                    </div>
                    {whoopBurn ? (
                      <>
                        <div style={{fontSize: 14, color: 'var(--text)', marginBottom: 4}}>
                          7-day avg burn: <span style={{fontFamily: 'var(--mono)', fontWeight: 600}}>{whoopBurn.toLocaleString()} kcal</span>
                        </div>
                        <div style={{fontSize: 12, color: 'var(--text-dim)'}}>
                          This is your true maintenance. Your daily target uses your actual burn each day.
                        </div>
                      </>
                    ) : (
                      <div style={{fontSize: 13, color: 'var(--text-dim)'}}>
                        Pulling your recent data...
                      </div>
                    )}
                  </div>
                </div>
                <button onClick={() => setStep(3)} style={{...S.primaryBtn, width: '100%'}}>
                  Continue <ChevronRight size={18} />
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => { window.location.href = '/api/whoop/auth-url'; }}
                  style={{...S.primaryBtn, width: '100%', marginBottom: 12}}
                >
                  <Activity size={16} /> Connect Whoop
                </button>
                <div style={{marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--line)'}}>
                  <div style={{fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.15em', color: 'var(--text-faint)', textTransform: 'uppercase', marginBottom: 10}}>
                    Or skip — enter manually
                  </div>
                  <div style={S.fieldHint}>Your estimated maintenance calories (TDEE) on a normal day.</div>
                  <div style={S.inputWrap}>
                    <input
                      style={S.input}
                      type="number"
                      inputMode="numeric"
                      value={manualMaintenance}
                      onChange={e => setManualMaintenance(e.target.value)}
                      placeholder={weight ? String(Math.round(parseFloat(weight) * 16)) : '2900'}
                    />
                    <span style={S.inputSuffix}>kcal</span>
                  </div>
                  <div style={{fontSize: 11, color: 'var(--text-faint)', marginTop: 6}}>
                    Rough estimate: weight × 16 = {weight ? Math.round(parseFloat(weight) * 16).toLocaleString() : '—'} kcal
                  </div>
                  <button
                    onClick={() => setStep(3)}
                    disabled={!manualMaintenance}
                    style={{...S.secondaryBtn, width: '100%', marginTop: 14, opacity: manualMaintenance ? 1 : 0.4}}
                  >
                    Continue without Whoop
                  </button>
                </div>
              </>
            )}
          </>
        )}

        {/* STEP 3: Pick plan */}
        {step === 3 && (
          <>
            <div style={{fontFamily: 'var(--display)', fontSize: 26, fontWeight: 400, fontStyle: 'italic', marginBottom: 8, letterSpacing: '-0.02em'}}>
              Pick your angle
            </div>
            <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 20, lineHeight: 1.5}}>
              Each plan sets your default deficit. Recovery and strain still scale daily on top. You can change plans anytime.
            </div>

            <div style={{display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20}}>
              {GOAL_PLANS.map(plan => {
                const isSelected = selectedPlan === plan.id;
                return (
                  <button
                    key={plan.id}
                    onClick={() => setSelectedPlan(plan.id)}
                    style={{
                      textAlign: 'left',
                      background: isSelected ? 'rgba(212,255,63,0.05)' : 'var(--bg-elev)',
                      border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--line)'}`,
                      borderRadius: 14,
                      padding: '14px 16px',
                      cursor: 'pointer',
                      fontFamily: 'var(--sans)',
                      color: 'var(--text)',
                      transition: 'all 0.15s',
                      position: 'relative',
                    }}
                  >
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6}}>
                      <div style={{display: 'flex', alignItems: 'baseline', gap: 8}}>
                        <span style={{fontWeight: 600, fontSize: 15}}>{plan.label}</span>
                        {plan.recommended && (
                          <span style={{
                            fontFamily: 'var(--mono)', fontSize: 8, letterSpacing: '0.12em',
                            color: 'var(--accent)', textTransform: 'uppercase', fontWeight: 600,
                          }}>recommended</span>
                        )}
                      </div>
                      <div style={{fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)'}}>
                        {plan.deficit > 0 ? `−${plan.deficit}` : '±0'} kcal · {plan.weeklyLoss > 0 ? `~${plan.weeklyLoss} lb/wk` : 'no loss'}
                      </div>
                    </div>
                    <div style={{fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.4}}>
                      {plan.blurb}
                    </div>
                  </button>
                );
              })}
            </div>

            <button
              style={{...S.primaryBtn, width: '100%'}}
              onClick={handleFinish}
            >
              Begin <ChevronRight size={18} />
            </button>
          </>
        )}

        {/* Back button (steps 2+) */}
        {step > 1 && (
          <button
            onClick={() => setStep(step - 1)}
            style={{
              background: 'none', border: 'none', color: 'var(--text-faint)',
              fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
              textTransform: 'uppercase', cursor: 'pointer', padding: 0,
              marginTop: 20, fontWeight: 600,
            }}
          >
            ← Back
          </button>
        )}
      </div>
      <GlobalStyles />
    </div>
  );
}

// ============ TODAY VIEW ============
function TodayView({ target, consumed, meals, whoop, recoveryBand, savedMeals, weights, profile, onAddMeal, onSaveMeal, onDeleteSaved, onIncrementSavedUse, onDeleteMeal, onLogWeight }) {
  const [addMode, setAddMode] = useState(null); // 'menu' | 'photo' | 'manual' | 'saved' | null
  const [showWeight, setShowWeight] = useState(false);
  const remaining = target.calories - consumed.calories;
  const pct = Math.min(100, (consumed.calories / target.calories) * 100);

  const recoveryLabel = whoop ? `${Math.round(whoop.recovery)}% recovery` : 'No recovery data';
  const recoveryColor = recoveryBand === 'green' ? 'var(--accent)' : recoveryBand === 'yellow' ? '#fbbf24' : 'var(--bad)';

  const todayWeight = weights.find(w => w.date === todayKey());
  const lastWeight = [...weights].sort((a, b) => b.date.localeCompare(a.date))[0];

  // Subtitle for target card explains the math
  let subText;
  if (target.source === 'whoop') {
    if (target.deficit === 0) {
      subText = `Whoop burn ${target.tdee.toLocaleString()} · maintenance, low recovery`;
    } else {
      subText = `Whoop burn ${target.tdee.toLocaleString()} − ${target.deficit} kcal cut`;
    }
  } else if (target.deficit === 0 && target.strainBump === 0) {
    subText = 'Maintenance · low recovery, eat to recover';
  } else if (target.deficit > 0 && target.strainBump > 0) {
    subText = `${target.deficit} kcal cut + ${target.strainBump} for high strain`;
  } else if (target.strainBump > 0) {
    subText = `Maintenance + ${target.strainBump} kcal · fueling hard day`;
  } else {
    subText = `${target.deficit} kcal deficit · ${recoveryBand === 'yellow' ? 'reduced for amber recovery' : 'standard cut day'}`;
  }

  return (
    <div style={S.view}>
      {/* Target card */}
      <div style={S.targetCard}>
        <div style={S.targetCardGlow} />
        <div style={S.targetLabel}>
          <span>Today's target</span>
          <span style={{color: recoveryColor, fontWeight: 600}}>● {recoveryLabel}</span>
        </div>
        <div style={S.targetNumber}>
          {target.calories.toLocaleString()}
          <span style={S.targetUnit}>kcal</span>
        </div>
        <div style={S.targetSub}>{subText}</div>

        {/* Progress bar */}
        <div style={{marginTop: 20}}>
          <div style={S.progressTrack}>
            <div style={{...S.progressFill, width: `${pct}%`}} />
          </div>
          <div style={S.progressMeta}>
            <span style={{color: 'var(--text)'}}><span style={{fontFamily: 'var(--mono)', fontWeight: 600}}>{Math.round(consumed.calories)}</span> consumed</span>
            <span style={{color: remaining >= 0 ? 'var(--text-dim)' : 'var(--bad)'}}>
              <span style={{fontFamily: 'var(--mono)', fontWeight: 600}}>{Math.abs(Math.round(remaining))}</span> {remaining >= 0 ? 'left' : 'over'}
            </span>
          </div>
        </div>
      </div>

      {/* Macros */}
      <div style={S.macroGrid}>
        <MacroPill icon={Beef} label="Protein" value={Math.round(consumed.protein)} target={target.protein} unit="g" highlight />
        <MacroPill icon={Wheat} label="Carbs" value={Math.round(consumed.carbs)} target={null} unit="g" />
        <MacroPill icon={Droplet} label="Fat" value={Math.round(consumed.fat)} target={null} unit="g" />
      </div>

      {/* Quick stats row: weight + (burn) + strain */}
      <div style={whoop?.burn ? S.quickStatsRow3 : S.quickStatsRow}>
        <button onClick={() => setShowWeight(true)} style={S.quickStat}>
          <Scale size={13} strokeWidth={1.75} style={{color: 'var(--text-dim)'}} />
          <span style={S.quickStatLabel}>Weight</span>
          <span style={S.quickStatValue}>
            {todayWeight ? `${todayWeight.lbs}` : (lastWeight ? `${lastWeight.lbs}` : 'Log')}
          </span>
          {todayWeight && <Check size={11} style={{color: 'var(--accent)', marginLeft: 4}} />}
        </button>
        {whoop?.burn && (
          <div style={S.quickStat}>
            <Flame size={13} strokeWidth={1.75} style={{color: 'var(--accent)'}} />
            <span style={S.quickStatLabel}>Burn</span>
            <span style={S.quickStatValue}>
              {Math.round(whoop.burn).toLocaleString()}
            </span>
          </div>
        )}
        <div style={S.quickStat}>
          <Zap size={13} strokeWidth={1.75} style={{color: 'var(--text-dim)'}} />
          <span style={S.quickStatLabel}>Strain</span>
          <span style={S.quickStatValue}>
            {whoop?.strain ? whoop.strain.toFixed(1) : '—'}
          </span>
        </div>
      </div>

      {/* Add meal — three options */}
      <div style={S.addMealRow}>
        <button onClick={() => setAddMode('photo')} style={S.addMealPrimary}>
          <Camera size={17} strokeWidth={2} />
          <span>Snap meal</span>
        </button>
        <button onClick={() => setAddMode('manual')} style={S.addMealSecondary} title="Enter manually">
          <Type size={16} strokeWidth={2} />
        </button>
        <button onClick={() => setAddMode('saved')} style={S.addMealSecondary} title="From library">
          <Bookmark size={16} strokeWidth={2} />
        </button>
      </div>

      {/* Meal list */}
      <div style={{marginTop: 24}}>
        <div style={S.sectionLabel}>Today's meals · {meals.length}</div>
        {meals.length === 0 && (
          <div style={S.emptyState}>No meals yet. Snap a photo, type one in, or pick from your library.</div>
        )}
        {meals.map(m => (
          <MealCard
            key={m._key}
            meal={m}
            onDelete={() => onDeleteMeal(m)}
            onSaveToLibrary={() => onSaveMeal(m)}
            isSaved={savedMeals.some(s => s.name.toLowerCase() === m.name.toLowerCase())}
          />
        ))}
      </div>

      {addMode === 'photo' && (
        <PhotoCapture
          onClose={() => setAddMode(null)}
          onSave={(meal) => { onAddMeal(meal); setAddMode(null); }}
        />
      )}
      {addMode === 'manual' && (
        <ManualEntry
          onClose={() => setAddMode(null)}
          onSave={(meal) => { onAddMeal(meal); setAddMode(null); }}
        />
      )}
      {addMode === 'saved' && (
        <SavedMealsPicker
          savedMeals={savedMeals}
          onClose={() => setAddMode(null)}
          onPick={(saved) => {
            onAddMeal({
              name: saved.name,
              calories: saved.calories,
              protein: saved.protein,
              carbs: saved.carbs,
              fat: saved.fat,
            });
            onIncrementSavedUse(saved.id);
            setAddMode(null);
          }}
          onDelete={onDeleteSaved}
        />
      )}
      {showWeight && (
        <WeightLogModal
          currentWeight={todayWeight}
          lastWeight={lastWeight}
          onClose={() => setShowWeight(false)}
          onSave={(w) => { onLogWeight(w); setShowWeight(false); }}
        />
      )}
    </div>
  );
}

function MacroPill({ icon: Icon, label, value, target, unit, highlight }) {
  const pct = target ? Math.min(100, (value / target) * 100) : null;
  return (
    <div style={{...S.macroPill, ...(highlight ? S.macroPillHighlight : {})}}>
      <div style={S.macroHeader}>
        <Icon size={12} strokeWidth={2} style={{color: highlight ? 'var(--accent)' : 'var(--text-dim)'}} />
        <span style={S.macroLabel}>{label}</span>
      </div>
      <div style={S.macroValue}>
        {value}<span style={S.macroUnit}>{unit}</span>
      </div>
      {target && (
        <div style={S.macroTarget}>of {target}{unit} {pct >= 100 && '✓'}</div>
      )}
    </div>
  );
}

function MealCard({ meal, onDelete, onSaveToLibrary, isSaved }) {
  const time = new Date(meal.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return (
    <div style={S.mealCard}>
      {meal.photo
        ? <img src={meal.photo} alt="" style={S.mealPhoto} />
        : <div style={{...S.mealPhoto, background: 'var(--bg-elev-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--line)'}}>
            <Type size={18} style={{color: 'var(--text-faint)'}} />
          </div>
      }
      <div style={{flex: 1, minWidth: 0}}>
        <div style={S.mealName}>{meal.name}</div>
        <div style={S.mealMeta}>
          <span>{time}</span>
          <span style={S.mealDot}>·</span>
          <span style={{fontFamily: 'var(--mono)'}}>{Math.round(meal.calories)} kcal</span>
          <span style={S.mealDot}>·</span>
          <span style={{fontFamily: 'var(--mono)'}}>{Math.round(meal.protein)}g P</span>
        </div>
      </div>
      {onSaveToLibrary && !isSaved && (
        <button onClick={onSaveToLibrary} style={S.iconBtn} title="Save to library">
          <Bookmark size={13} />
        </button>
      )}
      {isSaved && (
        <div style={{...S.iconBtn, background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'default'}} title="In library">
          <Bookmark size={13} fill="currentColor" />
        </div>
      )}
      <button onClick={onDelete} style={S.iconBtn}><Trash2 size={13} /></button>
    </div>
  );
}

// ============ PHOTO CAPTURE ============
function PhotoCapture({ onClose, onSave }) {
  const [stage, setStage] = useState('capture'); // capture | analyzing | review
  const [preview, setPreview] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const handleFile = async (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result;
      setPreview(dataUrl);
      setStage('analyzing');
      setError(null);
      try {
        const base64 = dataUrl.split(',')[1];
        const mime = file.type || 'image/jpeg';
        const result = await analyzeFoodPhoto(base64, mime);
        setAnalysis(result);
        setStage('review');
      } catch (e) {
        console.error(e);
        setError('Could not analyze photo. Try again or enter manually.');
        setStage('review');
        setAnalysis({ name: '', calories: 0, protein: 0, carbs: 0, fat: 0, confidence: 'low', notes: '' });
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>{stage === 'review' ? 'Confirm meal' : 'New meal'}</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>

        {stage === 'capture' && (
          <div style={{padding: '20px 24px 32px'}}>
            <div style={S.captureBox} onClick={() => fileRef.current?.click()}>
              <Camera size={32} strokeWidth={1.5} style={{color: 'var(--text-dim)', marginBottom: 12}} />
              <div style={{fontWeight: 500, marginBottom: 4}}>Take or upload photo</div>
              <div style={{fontSize: 12, color: 'var(--text-dim)'}}>AI will estimate calories & macros</div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              style={{display: 'none'}}
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </div>
        )}

        {stage === 'analyzing' && (
          <div style={{padding: '32px 24px', textAlign: 'center'}}>
            {preview && <img src={preview} alt="" style={{width: '100%', borderRadius: 12, marginBottom: 24}} />}
            <Loader2 size={20} style={{animation: 'spin 1s linear infinite', color: 'var(--accent)'}} />
            <div style={{marginTop: 12, color: 'var(--text-dim)', fontSize: 13}}>Analyzing your meal…</div>
          </div>
        )}

        {stage === 'review' && analysis && (
          <ReviewMeal preview={preview} analysis={analysis} error={error} onCancel={onClose} onSave={(m) => onSave({ ...m, photo: preview })} />
        )}
      </div>
    </div>
  );
}

function ReviewMeal({ preview, analysis, error, onCancel, onSave }) {
  const [name, setName] = useState(analysis.name || '');
  const [calories, setCalories] = useState(String(analysis.calories || ''));
  const [protein, setProtein] = useState(String(analysis.protein || ''));
  const [carbs, setCarbs] = useState(String(analysis.carbs || ''));
  const [fat, setFat] = useState(String(analysis.fat || ''));

  return (
    <div style={{padding: '0 24px 32px'}}>
      {preview && <img src={preview} alt="" style={{width: '100%', borderRadius: 12, marginBottom: 16}} />}
      {error && <div style={S.errorBox}>{error}</div>}
      {!error && analysis.notes && (
        <div style={S.aiNote}>
          <span style={{color: 'var(--accent)', fontWeight: 600}}>AI</span> · {analysis.notes}
          {analysis.confidence === 'low' && <span style={{color: 'var(--warn)'}}> (low confidence — double-check)</span>}
        </div>
      )}

      <div style={{marginBottom: 14}}>
        <label style={S.fieldLabel}>Meal</label>
        <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Chicken bowl" />
      </div>

      <div style={S.macroEditGrid}>
        <div>
          <label style={S.fieldLabelSm}>Calories</label>
          <input style={S.inputSm} type="number" value={calories} onChange={e => setCalories(e.target.value)} />
        </div>
        <div>
          <label style={S.fieldLabelSm}>Protein</label>
          <input style={S.inputSm} type="number" value={protein} onChange={e => setProtein(e.target.value)} />
        </div>
        <div>
          <label style={S.fieldLabelSm}>Carbs</label>
          <input style={S.inputSm} type="number" value={carbs} onChange={e => setCarbs(e.target.value)} />
        </div>
        <div>
          <label style={S.fieldLabelSm}>Fat</label>
          <input style={S.inputSm} type="number" value={fat} onChange={e => setFat(e.target.value)} />
        </div>
      </div>

      <div style={{display: 'flex', gap: 10, marginTop: 24}}>
        <button onClick={onCancel} style={{...S.secondaryBtn, flex: 1}}>Cancel</button>
        <button
          onClick={() => onSave({
            name: name || 'Meal',
            calories: parseFloat(calories) || 0,
            protein: parseFloat(protein) || 0,
            carbs: parseFloat(carbs) || 0,
            fat: parseFloat(fat) || 0,
          })}
          style={{...S.primaryBtn, flex: 1}}
        >
          <Check size={16} /> Save meal
        </button>
      </div>
    </div>
  );
}

// ============ MANUAL ENTRY ============
function ManualEntry({ onClose, onSave }) {
  const [name, setName] = useState('');
  const [calories, setCalories] = useState('');
  const [protein, setProtein] = useState('');
  const [carbs, setCarbs] = useState('');
  const [fat, setFat] = useState('');

  const valid = name && calories;

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>Log meal</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          <div style={{marginBottom: 14}}>
            <label style={S.fieldLabel}>Meal name</label>
            <input style={S.input} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Greek yogurt + berries" autoFocus />
          </div>

          <div style={{marginBottom: 14}}>
            <label style={S.fieldLabel}>Calories</label>
            <div style={S.inputWrap}>
              <input style={S.input} type="number" inputMode="numeric" value={calories} onChange={e => setCalories(e.target.value)} placeholder="0" />
              <span style={S.inputSuffix}>kcal</span>
            </div>
          </div>

          <div style={S.macroEditGrid}>
            <div>
              <label style={S.fieldLabelSm}>Protein</label>
              <input style={S.inputSm} type="number" inputMode="numeric" value={protein} onChange={e => setProtein(e.target.value)} placeholder="0g" />
            </div>
            <div>
              <label style={S.fieldLabelSm}>Carbs</label>
              <input style={S.inputSm} type="number" inputMode="numeric" value={carbs} onChange={e => setCarbs(e.target.value)} placeholder="0g" />
            </div>
            <div>
              <label style={S.fieldLabelSm}>Fat</label>
              <input style={S.inputSm} type="number" inputMode="numeric" value={fat} onChange={e => setFat(e.target.value)} placeholder="0g" />
            </div>
            <div style={{display: 'flex', alignItems: 'flex-end'}}>
              <div style={{fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)', textAlign: 'right', width: '100%'}}>
                Macros optional<br/>but recommended
              </div>
            </div>
          </div>

          <div style={{display: 'flex', gap: 10, marginTop: 24}}>
            <button onClick={onClose} style={{...S.secondaryBtn, flex: 1}}>Cancel</button>
            <button
              disabled={!valid}
              onClick={() => onSave({
                name,
                calories: parseFloat(calories) || 0,
                protein: parseFloat(protein) || 0,
                carbs: parseFloat(carbs) || 0,
                fat: parseFloat(fat) || 0,
              })}
              style={{...S.primaryBtn, flex: 1, opacity: valid ? 1 : 0.4}}
            >
              <Check size={16} /> Add meal
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============ SAVED MEALS PICKER ============
function SavedMealsPicker({ savedMeals, onClose, onPick, onDelete }) {
  const [search, setSearch] = useState('');
  const filtered = savedMeals
    .filter(s => s.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => (b.uses || 0) - (a.uses || 0));

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>Library</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          {savedMeals.length === 0 ? (
            <div style={{...S.emptyState, padding: '32px 20px'}}>
              <div style={{marginBottom: 8}}>No saved meals yet.</div>
              <div style={{fontSize: 12, color: 'var(--text-faint)'}}>Save meals you eat often by tapping the bookmark icon on any logged meal.</div>
            </div>
          ) : (
            <>
              <input
                style={{...S.input, marginBottom: 14}}
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search saved meals…"
              />
              {filtered.length === 0 ? (
                <div style={{padding: '20px 0', color: 'var(--text-faint)', fontSize: 13, textAlign: 'center'}}>No matches.</div>
              ) : (
                <div style={{maxHeight: '50vh', overflowY: 'auto', margin: '0 -4px', padding: '0 4px'}}>
                  {filtered.map(s => (
                    <div key={s.id} style={S.savedMealRow}>
                      <button onClick={() => onPick(s)} style={S.savedMealMain}>
                        <div style={{flex: 1, minWidth: 0, textAlign: 'left'}}>
                          <div style={{fontWeight: 500, fontSize: 14, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{s.name}</div>
                          <div style={{fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)'}}>
                            {Math.round(s.calories)} kcal · {Math.round(s.protein)}P · {Math.round(s.carbs)}C · {Math.round(s.fat)}F
                            {s.uses > 0 && <span style={{color: 'var(--text-faint)'}}> · used {s.uses}×</span>}
                          </div>
                        </div>
                        <Plus size={16} style={{color: 'var(--accent)'}} />
                      </button>
                      <button onClick={() => { if (confirm(`Remove "${s.name}" from library?`)) onDelete(s.id); }} style={S.iconBtn}>
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ============ WEIGHT LOG MODAL ============
function WeightLogModal({ currentWeight, lastWeight, onClose, onSave }) {
  const [lbs, setLbs] = useState(currentWeight ? String(currentWeight.lbs) : '');
  const [date, setDate] = useState(currentWeight?.date || todayKey());

  const valid = lbs && parseFloat(lbs) > 0;
  const delta = lastWeight && lbs ? parseFloat(lbs) - lastWeight.lbs : null;

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>Morning weigh-in</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          <div style={S.fieldHint}>
            Weigh in first thing, after bathroom, before water or food. Daily readings vary 1–3 lbs — the trend matters, not single days.
          </div>

          <div style={{marginBottom: 14, marginTop: 16}}>
            <label style={S.fieldLabel}>Date</label>
            <input style={S.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>

          <div style={{marginBottom: 8}}>
            <label style={S.fieldLabel}>Weight</label>
            <div style={S.inputWrap}>
              <input style={S.input} type="number" step="0.1" inputMode="decimal" value={lbs} onChange={e => setLbs(e.target.value)} placeholder={lastWeight ? String(lastWeight.lbs) : '180'} autoFocus />
              <span style={S.inputSuffix}>lbs</span>
            </div>
          </div>

          {delta !== null && Math.abs(delta) > 0.05 && (
            <div style={{fontSize: 12, color: delta < 0 ? 'var(--good)' : 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 6}}>
              {delta > 0 ? '+' : ''}{delta.toFixed(1)} lbs vs last weigh-in ({fmtDate(lastWeight.date)})
            </div>
          )}

          <button
            disabled={!valid}
            onClick={() => onSave({ date, lbs: parseFloat(lbs), timestamp: Date.now() })}
            style={{...S.primaryBtn, width: '100%', marginTop: 24, opacity: valid ? 1 : 0.4}}
          >
            <Check size={16} /> Save weight
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ INSIGHTS VIEW ============
function InsightsView({ meals, weights, scans, whoop, profile }) {
  // Last 7 and 14 days
  const today = new Date();
  const dateNDaysAgo = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
  };

  // Group meals by date
  const dayMap = {};
  for (const m of meals) {
    if (!dayMap[m.date]) dayMap[m.date] = { calories: 0, protein: 0, mealCount: 0 };
    dayMap[m.date].calories += m.calories || 0;
    dayMap[m.date].protein += m.protein || 0;
    dayMap[m.date].mealCount++;
  }

  // 7-day stats
  const last7Dates = Array.from({length: 7}, (_, i) => dateNDaysAgo(6 - i));
  const last7Days = last7Dates.map(d => ({ date: d, ...(dayMap[d] || { calories: 0, protein: 0, mealCount: 0 }) }));
  const loggedDays7 = last7Days.filter(d => d.mealCount > 0);
  const avgCals7 = loggedDays7.length ? loggedDays7.reduce((s, d) => s + d.calories, 0) / loggedDays7.length : 0;
  const avgProtein7 = loggedDays7.length ? loggedDays7.reduce((s, d) => s + d.protein, 0) / loggedDays7.length : 0;

  // Compute weekly deficit projection
  const proteinTarget = (profile?.weightLbs || 180) * 1.0;
  const proteinHitRate = loggedDays7.length ? loggedDays7.filter(d => d.protein >= proteinTarget * 0.9).length / loggedDays7.length : 0;

  // Weekly deficit: prefer per-day Whoop burn when available, fall back to static maintenance
  const whoopByDate = {};
  for (const w of whoop) whoopByDate[w.date] = w;
  let weeklyDeficit = 0;
  let deficitSource = 'static';
  let burnDaysUsed = 0;
  for (const d of loggedDays7) {
    const dayBurn = whoopByDate[d.date]?.burn;
    if (dayBurn && dayBurn > 1000) {
      weeklyDeficit += (dayBurn - d.calories);
      burnDaysUsed++;
    } else if (profile?.maintenance) {
      weeklyDeficit += (profile.maintenance - d.calories);
    }
  }
  if (burnDaysUsed === loggedDays7.length && loggedDays7.length > 0) deficitSource = 'whoop';
  else if (burnDaysUsed > 0) deficitSource = 'mixed';

  // Average daily burn (for context display)
  const burnsLast7 = last7Days.map(d => whoopByDate[d.date]?.burn).filter(b => b && b > 1000);
  const avgBurn7 = burnsLast7.length ? burnsLast7.reduce((s, b) => s + b, 0) / burnsLast7.length : null;

  // Weight trend (7-day moving average)
  const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const last14Weights = sortedWeights.slice(-14);
  const weightTrend = (() => {
    if (last14Weights.length < 4) return null;
    const half = Math.floor(last14Weights.length / 2);
    const first = last14Weights.slice(0, half);
    const second = last14Weights.slice(half);
    const avgFirst = first.reduce((s, w) => s + w.lbs, 0) / first.length;
    const avgSecond = second.reduce((s, w) => s + w.lbs, 0) / second.length;
    return avgSecond - avgFirst;
  })();

  // DEXA progress (latest vs first)
  const sortedScans = [...scans].sort((a, b) => a.date.localeCompare(b.date));
  const dexaProgress = sortedScans.length >= 2 ? {
    fatLost: sortedScans[0].fatLbs - sortedScans[sortedScans.length - 1].fatLbs,
    leanChange: sortedScans[sortedScans.length - 1].leanLbs - sortedScans[0].leanLbs,
    bfChange: sortedScans[sortedScans.length - 1].bodyFatPct - sortedScans[0].bodyFatPct,
    days: Math.round((new Date(sortedScans[sortedScans.length - 1].date) - new Date(sortedScans[0].date)) / 86400000),
  } : null;

  // Health check: lean mass holding?
  const leanMassVerdict = (() => {
    if (!dexaProgress) return null;
    if (dexaProgress.leanChange >= -0.5 && dexaProgress.fatLost > 0) return { type: 'good', text: 'Lean mass holding while losing fat. This is the goal.' };
    if (dexaProgress.leanChange < -1.5) return { type: 'bad', text: 'Lean mass dropping faster than ideal. Consider easing the deficit or upping protein.' };
    if (dexaProgress.fatLost <= 0) return { type: 'warn', text: 'Fat mass not yet trending down. Re-check maintenance estimate.' };
    return { type: 'ok', text: 'Body comp moving in the right direction.' };
  })();

  const maxCals = Math.max(profile?.maintenance || 3000, ...last7Days.map(d => d.calories));

  return (
    <div style={S.view}>
      <div style={S.sectionLabel}>7-day rolling</div>

      <div style={S.statsGrid2}>
        <div style={S.statCard}>
          <div style={S.scanCardLabel}>Avg eaten</div>
          <div style={S.scanStatValue}>{Math.round(avgCals7).toLocaleString()}<span style={S.scanStatUnit}>kcal</span></div>
          {avgBurn7 ? (
            <div style={S.scanStatLabel}>vs {Math.round(avgBurn7).toLocaleString()} avg burn (Whoop)</div>
          ) : profile?.maintenance ? (
            <div style={S.scanStatLabel}>{Math.round(profile.maintenance - avgCals7)} below maintenance</div>
          ) : null}
        </div>
        <div style={S.statCard}>
          <div style={S.scanCardLabel}>Avg protein</div>
          <div style={S.scanStatValue}>{Math.round(avgProtein7)}<span style={S.scanStatUnit}>g</span></div>
          <div style={S.scanStatLabel}>Target {Math.round(proteinTarget)}g · {Math.round(proteinHitRate * 100)}% days hit</div>
        </div>
      </div>

      {/* Weekly deficit estimate */}
      {(profile?.maintenance || avgBurn7) && loggedDays7.length >= 3 && (
        <div style={{...S.targetCard, marginTop: 14}}>
          <div style={S.targetCardGlow} />
          <div style={S.targetLabel}>
            <span>Weekly deficit · est. fat loss</span>
            {deficitSource === 'whoop' && <span style={{color: 'var(--accent)', fontSize: 9}}>● WHOOP</span>}
            {deficitSource === 'mixed' && <span style={{color: 'var(--text-dim)', fontSize: 9}}>● MIXED</span>}
          </div>
          <div style={{...S.targetNumber, fontSize: 48, position: 'relative', zIndex: 1}}>
            {weeklyDeficit > 0 ? '−' : '+'}{Math.abs(Math.round(weeklyDeficit / 3500 * 10) / 10)}
            <span style={S.targetUnit}>lbs/wk</span>
          </div>
          <div style={S.targetSub}>
            {Math.round(weeklyDeficit).toLocaleString()} kcal {weeklyDeficit > 0 ? 'deficit' : 'surplus'} across {loggedDays7.length} logged days
            {deficitSource === 'whoop' && ' · using actual daily burn'}
            {deficitSource === 'static' && ' · using static maintenance'}
            {deficitSource === 'mixed' && ` · ${burnDaysUsed}/${loggedDays7.length} days from Whoop`}
            {weeklyDeficit < 0 && ' — check if intentional'}
          </div>
        </div>
      )}

      {/* Calorie bars 7 days */}
      <div style={{...S.sectionLabel, marginTop: 24}}>Daily calories · last 7</div>
      <div style={S.statCard}>
        <div style={{display: 'flex', alignItems: 'flex-end', gap: 6, height: 100, marginBottom: 8}}>
          {last7Days.map((d, i) => {
            const dt = new Date(d.date);
            const h = d.calories > 0 ? Math.max(6, (d.calories / maxCals) * 100) : 4;
            const isOver = profile?.maintenance && d.calories > profile.maintenance;
            const isUnder = d.calories > 0 && profile?.maintenance && d.calories < profile.maintenance - profile.deficit * 1.4;
            const color = d.calories === 0 ? 'var(--line-bright)' : isUnder ? 'var(--warn)' : isOver ? 'var(--bad)' : 'var(--accent)';
            return (
              <div key={i} style={{flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4}}>
                <div style={{fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--mono)'}}>
                  {d.calories > 0 ? Math.round(d.calories / 100) / 10 + 'k' : '—'}
                </div>
                <div style={{width: '100%', height: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center'}}>
                  <div style={{width: '85%', height: h, background: color, borderRadius: 3, opacity: 0.85}} />
                </div>
                <div style={{fontSize: 9, color: 'var(--text-faint)', fontFamily: 'var(--mono)', textTransform: 'uppercase'}}>
                  {dt.toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1)}
                </div>
              </div>
            );
          })}
        </div>
        {profile?.maintenance && (
          <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em'}}>
            <span>Maintenance: {profile.maintenance.toLocaleString()}</span>
            <span>Days logged: {loggedDays7.length}/7</span>
          </div>
        )}
      </div>

      {/* Weight trend */}
      {weightTrend !== null && (
        <>
          <div style={{...S.sectionLabel, marginTop: 24}}>Scale trend</div>
          <div style={S.statCard}>
            <div style={S.scanCardLabel}>14-day weight movement</div>
            <div style={{...S.scanStatValue, color: weightTrend < 0 ? 'var(--good)' : weightTrend > 0.5 ? 'var(--warn)' : 'var(--text)'}}>
              {weightTrend > 0 ? '+' : ''}{weightTrend.toFixed(1)}<span style={S.scanStatUnit}>lbs</span>
            </div>
            <div style={S.scanStatLabel}>
              {Math.abs(weightTrend) < 0.5 ? 'Stable — could mean recomp or insufficient deficit'
                : weightTrend < -2 ? 'Fast loss — risk to lean mass, ease up'
                : weightTrend < 0 ? 'Steady fat loss pace'
                : 'Trending up — review intake'}
            </div>
          </div>
        </>
      )}

      {/* DEXA progress */}
      {dexaProgress && (
        <>
          <div style={{...S.sectionLabel, marginTop: 24}}>Body comp progress</div>
          <div style={S.statCard}>
            <div style={S.scanCardLabel}>Across {dexaProgress.days} days · {sortedScans.length} scans</div>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginTop: 12}}>
              <div>
                <div style={S.scanStatLabel}>Fat lost</div>
                <div style={{...S.scanStatValue, fontSize: 24, color: dexaProgress.fatLost > 0 ? 'var(--good)' : 'var(--text-dim)'}}>
                  {dexaProgress.fatLost > 0 ? '−' : ''}{Math.abs(dexaProgress.fatLost).toFixed(1)}<span style={S.scanStatUnit}>lb</span>
                </div>
              </div>
              <div>
                <div style={S.scanStatLabel}>Lean Δ</div>
                <div style={{...S.scanStatValue, fontSize: 24, color: dexaProgress.leanChange >= -0.5 ? 'var(--good)' : 'var(--bad)'}}>
                  {dexaProgress.leanChange > 0 ? '+' : ''}{dexaProgress.leanChange.toFixed(1)}<span style={S.scanStatUnit}>lb</span>
                </div>
              </div>
              <div>
                <div style={S.scanStatLabel}>Body fat</div>
                <div style={{...S.scanStatValue, fontSize: 24, color: dexaProgress.bfChange < 0 ? 'var(--good)' : 'var(--text-dim)'}}>
                  {dexaProgress.bfChange > 0 ? '+' : ''}{dexaProgress.bfChange.toFixed(1)}<span style={S.scanStatUnit}>%</span>
                </div>
              </div>
            </div>
            {leanMassVerdict && (
              <div style={{
                marginTop: 16, padding: '10px 12px', borderRadius: 8,
                background: leanMassVerdict.type === 'good' ? 'rgba(74,222,128,0.08)'
                  : leanMassVerdict.type === 'bad' ? 'rgba(248,113,113,0.08)'
                  : leanMassVerdict.type === 'warn' ? 'rgba(255,122,69,0.08)'
                  : 'var(--bg-elev-2)',
                border: `1px solid ${leanMassVerdict.type === 'good' ? 'rgba(74,222,128,0.25)' : leanMassVerdict.type === 'bad' ? 'rgba(248,113,113,0.25)' : leanMassVerdict.type === 'warn' ? 'rgba(255,122,69,0.25)' : 'var(--line)'}`,
                fontSize: 12,
                color: leanMassVerdict.type === 'good' ? 'var(--good)' : leanMassVerdict.type === 'bad' ? 'var(--bad)' : leanMassVerdict.type === 'warn' ? 'var(--warn)' : 'var(--text-dim)',
                lineHeight: 1.5,
              }}>
                {leanMassVerdict.text}
              </div>
            )}
          </div>
        </>
      )}

      {/* Empty state */}
      {loggedDays7.length === 0 && !dexaProgress && weights.length === 0 && (
        <div style={{...S.emptyCard, marginTop: 14}}>
          <div style={{fontFamily: 'var(--display)', fontSize: 22, fontWeight: 400, marginBottom: 6, fontStyle: 'italic'}}>Nothing to show yet</div>
          <div style={{color: 'var(--text-dim)', fontSize: 13}}>Log a few days of meals, weigh-ins, and DEXA scans. Trends start showing within a week.</div>
        </div>
      )}
    </div>
  );
}

// ============ BODY VIEW (DEXA + WEIGHT) ============
function BodyView({ scans, weights, onAddScan, onDeleteScan, onLogWeight, onDeleteWeight }) {
  const [showAdd, setShowAdd] = useState(false);
  const [showWeight, setShowWeight] = useState(false);
  const sorted = [...scans].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];

  const sortedWeights = [...weights].sort((a, b) => a.date.localeCompare(b.date));
  const recentWeights = sortedWeights.slice(-30);
  const todayWeight = weights.find(w => w.date === todayKey());
  const lastWeight = sortedWeights[sortedWeights.length - 1];

  const delta = (key) => {
    if (!latest || !previous) return null;
    return latest[key] - previous[key];
  };

  // Weight chart bounds
  const weightMin = recentWeights.length ? Math.min(...recentWeights.map(w => w.lbs)) - 1 : 0;
  const weightMax = recentWeights.length ? Math.max(...recentWeights.map(w => w.lbs)) + 1 : 0;
  const weightRange = weightMax - weightMin || 1;

  return (
    <div style={S.view}>
      {/* DEXA SECTION */}
      <div style={{...S.sectionLabel, marginBottom: 14}}>DEXA scans</div>

      {scans.length === 0 ? (
        <div style={S.emptyCard}>
          <div style={{fontFamily: 'var(--display)', fontSize: 22, fontWeight: 400, marginBottom: 6, fontStyle: 'italic'}}>No scans yet</div>
          <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 20}}>Add your DEXA results to start tracking lean mass over time.</div>
          <button onClick={() => setShowAdd(true)} style={S.primaryBtn}>
            <Plus size={16} /> Add first scan
          </button>
        </div>
      ) : (
        <>
          {/* Latest scan card */}
          <div style={S.scanLatestCard}>
            <div style={S.scanCardLabel}>Latest scan · {fmtDate(latest.date)}</div>
            <div style={S.scanStatGrid}>
              <ScanStat label="Body fat" value={latest.bodyFatPct} unit="%" delta={delta('bodyFatPct')} invert />
              <ScanStat label="Lean mass" value={latest.leanLbs} unit="lbs" delta={delta('leanLbs')} />
              <ScanStat label="Fat mass" value={latest.fatLbs} unit="lbs" delta={delta('fatLbs')} invert />
              <ScanStat label="Total wt" value={latest.totalLbs} unit="lbs" delta={delta('totalLbs')} />
            </div>
          </div>

          <button onClick={() => setShowAdd(true)} style={{...S.secondaryBtn, marginTop: 12, width: '100%'}}>
            <Plus size={16} /> Add new scan
          </button>

          {scans.length > 1 && (
            <>
              <div style={{...S.sectionLabel, marginTop: 24}}>Scan history</div>
              {sorted.slice().reverse().map((s, i) => {
                const realIdx = sorted.length - 1 - i;
                return (
                  <div key={s.date} style={S.scanRow}>
                    <div>
                      <div style={{fontWeight: 500}}>{fmtDate(s.date)}</div>
                      <div style={{fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 2}}>
                        {s.bodyFatPct}% · {s.leanLbs}lb lean · {s.fatLbs}lb fat
                      </div>
                    </div>
                    <button onClick={() => onDeleteScan(realIdx)} style={S.iconBtn}><Trash2 size={14} /></button>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}

      {/* WEIGHT SECTION */}
      <div style={{...S.sectionLabel, marginTop: 32}}>Daily weight</div>

      {weights.length === 0 ? (
        <div style={S.emptyCard}>
          <div style={{fontFamily: 'var(--display)', fontSize: 22, fontWeight: 400, marginBottom: 6, fontStyle: 'italic'}}>No weigh-ins yet</div>
          <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 20}}>Daily morning weigh-ins fill the gap between DEXA scans. Single days are noisy — the trend is the signal.</div>
          <button onClick={() => setShowWeight(true)} style={S.primaryBtn}>
            <Plus size={16} /> Log first weigh-in
          </button>
        </div>
      ) : (
        <>
          {/* Weight chart */}
          <div style={S.statCard}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 14}}>
              <div>
                <div style={S.scanCardLabel}>Latest</div>
                <div style={{...S.scanStatValue, fontSize: 28}}>{lastWeight.lbs}<span style={S.scanStatUnit}>lbs</span></div>
              </div>
              <div style={{textAlign: 'right'}}>
                <div style={{fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)'}}>{recentWeights.length} entries</div>
                <div style={{fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--mono)'}}>{fmtDate(lastWeight.date)}</div>
              </div>
            </div>

            {/* Mini chart */}
            {recentWeights.length >= 2 && (
              <svg width="100%" height="80" viewBox={`0 0 ${recentWeights.length * 12} 80`} preserveAspectRatio="none" style={{marginBottom: 6}}>
                <polyline
                  points={recentWeights.map((w, i) => `${i * 12 + 6},${75 - ((w.lbs - weightMin) / weightRange) * 65}`).join(' ')}
                  fill="none"
                  stroke="var(--accent)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {recentWeights.map((w, i) => (
                  <circle
                    key={i}
                    cx={i * 12 + 6}
                    cy={75 - ((w.lbs - weightMin) / weightRange) * 65}
                    r="2"
                    fill="var(--accent)"
                  />
                ))}
              </svg>
            )}
            <div style={{display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--mono)'}}>
              <span>{weightMin.toFixed(1)} lbs</span>
              <span>{weightMax.toFixed(1)} lbs</span>
            </div>
          </div>

          <button onClick={() => setShowWeight(true)} style={{...S.secondaryBtn, marginTop: 12, width: '100%'}}>
            {todayWeight ? <><Edit3 size={14} /> Update today's weight</> : <><Plus size={16} /> Log today</>}
          </button>

          {sortedWeights.length > 1 && (
            <>
              <div style={{...S.sectionLabel, marginTop: 20, fontSize: 9}}>Recent weigh-ins</div>
              {sortedWeights.slice().reverse().slice(0, 10).map(w => (
                <div key={w.date} style={S.scanRow}>
                  <div>
                    <div style={{fontWeight: 500, fontSize: 14}}>{fmtDate(w.date)}</div>
                  </div>
                  <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
                    <span style={{fontFamily: 'var(--mono)', fontWeight: 600}}>{w.lbs} lbs</span>
                    <button onClick={() => onDeleteWeight(w.date)} style={S.iconBtn}><Trash2 size={13} /></button>
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}

      {showAdd && <AddScanModal onClose={() => setShowAdd(false)} onSave={(s) => { onAddScan(s); setShowAdd(false); }} />}
      {showWeight && <WeightLogModal currentWeight={todayWeight} lastWeight={lastWeight} onClose={() => setShowWeight(false)} onSave={(w) => { onLogWeight(w); setShowWeight(false); }} />}
    </div>
  );
}

function ScanStat({ label, value, unit, delta, invert }) {
  let deltaColor = 'var(--text-dim)';
  let deltaSign = '';
  if (delta !== null && delta !== undefined && Math.abs(delta) > 0.01) {
    const isGood = invert ? delta < 0 : delta > 0;
    deltaColor = isGood ? 'var(--good)' : 'var(--bad)';
    deltaSign = delta > 0 ? '+' : '';
  }
  return (
    <div style={S.scanStatCell}>
      <div style={S.scanStatLabel}>{label}</div>
      <div style={S.scanStatValue}>{value}<span style={S.scanStatUnit}>{unit}</span></div>
      {delta !== null && delta !== undefined && (
        <div style={{...S.scanStatDelta, color: deltaColor}}>
          {deltaSign}{delta.toFixed(1)}
        </div>
      )}
    </div>
  );
}

function AddScanModal({ onClose, onSave }) {
  const [date, setDate] = useState(todayKey());
  const [bodyFatPct, setBodyFatPct] = useState('');
  const [leanLbs, setLeanLbs] = useState('');
  const [fatLbs, setFatLbs] = useState('');
  const [totalLbs, setTotalLbs] = useState('');

  const valid = date && bodyFatPct && leanLbs && fatLbs;

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>Add DEXA scan</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          <div style={{marginBottom: 14}}>
            <label style={S.fieldLabel}>Date</label>
            <input style={S.input} type="date" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div style={S.macroEditGrid}>
            <div>
              <label style={S.fieldLabelSm}>Body fat %</label>
              <input style={S.inputSm} type="number" step="0.1" value={bodyFatPct} onChange={e => setBodyFatPct(e.target.value)} placeholder="14.5" />
            </div>
            <div>
              <label style={S.fieldLabelSm}>Total lbs</label>
              <input style={S.inputSm} type="number" step="0.1" value={totalLbs} onChange={e => setTotalLbs(e.target.value)} placeholder="180" />
            </div>
            <div>
              <label style={S.fieldLabelSm}>Lean lbs</label>
              <input style={S.inputSm} type="number" step="0.1" value={leanLbs} onChange={e => setLeanLbs(e.target.value)} placeholder="148" />
            </div>
            <div>
              <label style={S.fieldLabelSm}>Fat lbs</label>
              <input style={S.inputSm} type="number" step="0.1" value={fatLbs} onChange={e => setFatLbs(e.target.value)} placeholder="26" />
            </div>
          </div>
          <button
            disabled={!valid}
            onClick={() => onSave({
              date,
              bodyFatPct: parseFloat(bodyFatPct),
              leanLbs: parseFloat(leanLbs),
              fatLbs: parseFloat(fatLbs),
              totalLbs: parseFloat(totalLbs) || (parseFloat(leanLbs) + parseFloat(fatLbs)),
            })}
            style={{...S.primaryBtn, width: '100%', marginTop: 20, opacity: valid ? 1 : 0.4}}
          >
            <Check size={16} /> Save scan
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ RECOVERY VIEW ============
function RecoveryView({ whoop, sheetUrl, lastSync, syncing, whoopConnected, whoopBanner, onSyncWhoopOAuth, onDisconnectWhoop, onSaveSheetUrl, onSync, onImport, onClear }) {
  const fileRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState('');
  const [showSheetSetup, setShowSheetSetup] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(false);

  const sorted = [...whoop].sort((a, b) => b.date.localeCompare(a.date));
  const recent = sorted.slice(0, 14);

  // 7-day HRV trend
  const last7 = sorted.slice(0, 7);
  const prev7 = sorted.slice(7, 14);
  const avg = (arr, key) => arr.length ? arr.reduce((s, x) => s + (x[key] || 0), 0) / arr.length : 0;
  const hrvTrend = last7.length >= 5 && prev7.length >= 5 ? avg(last7, 'hrv') - avg(prev7, 'hrv') : null;
  const rhrTrend = last7.length >= 5 && prev7.length >= 5 ? avg(last7, 'rhr') - avg(prev7, 'rhr') : null;

  const handleFile = (file) => {
    if (!file) return;
    setImporting(true);
    setImportMsg('');
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const rows = parseWhoopCSV(reader.result);
        if (rows.length === 0) {
          setImportMsg('No valid rows found. Make sure this is a Whoop CSV export.');
          setImporting(false);
          return;
        }
        await onImport(rows);
        setImportMsg(`Imported ${rows.length} day${rows.length === 1 ? '' : 's'} of recovery data.`);
      } catch (e) {
        setImportMsg('Could not parse file. Try a fresh Whoop CSV export.');
      }
      setImporting(false);
    };
    reader.readAsText(file);
  };

  const handleSync = async () => {
    setImportMsg('');
    const result = await onSync();
    setImportMsg(result.msg);
  };

  const lastSyncText = lastSync
    ? (() => {
        const mins = Math.floor((Date.now() - lastSync) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
      })()
    : 'never';

  return (
    <div style={S.view}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12}}>
        <div style={S.sectionLabel}>Whoop recovery</div>
        {(whoopConnected || sheetUrl) && (
          <div style={{display: 'flex', alignItems: 'center', gap: 6, fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em', color: 'var(--accent)', textTransform: 'uppercase'}}>
            <span style={{display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--accent)'}} />
            Live · {lastSyncText}
          </div>
        )}
      </div>

      {/* Banner from OAuth callback */}
      {whoopBanner && (
        <div style={{
          padding: '10px 14px', borderRadius: 10, marginBottom: 12, fontSize: 13,
          background: whoopBanner.type === 'success' ? 'rgba(212,255,63,0.08)' : 'rgba(248,113,113,0.08)',
          border: `1px solid ${whoopBanner.type === 'success' ? 'rgba(212,255,63,0.25)' : 'rgba(248,113,113,0.25)'}`,
          color: whoopBanner.type === 'success' ? 'var(--accent)' : 'var(--bad)',
        }}>
          {whoopBanner.text}
        </div>
      )}

      {/* WHOOP OAUTH CARD - primary connection method */}
      <div style={{...S.targetCard, marginBottom: 12, padding: '16px 18px'}}>
        <div style={S.targetCardGlow} />
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, position: 'relative', zIndex: 1}}>
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em', color: whoopConnected ? 'var(--accent)' : 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4, fontWeight: 600}}>
              {whoopConnected ? '● Connected via Whoop API' : 'Connect Whoop'}
            </div>
            <div style={{fontSize: 13, color: 'var(--text)', lineHeight: 1.4}}>
              {whoopConnected
                ? 'Recovery, strain, sleep, and calorie burn sync directly from Whoop\'s API every time you open the app.'
                : 'One-tap OAuth. Pulls everything Protocol needs directly from Whoop — no spreadsheets, no Zapier.'}
            </div>
          </div>
        </div>
        <div style={{marginTop: 14, display: 'flex', gap: 8, position: 'relative', zIndex: 1}}>
          {whoopConnected ? (
            <>
              <button
                onClick={async () => {
                  setOauthBusy(true);
                  setImportMsg('');
                  const r = await onSyncWhoopOAuth();
                  setImportMsg(r.msg);
                  setOauthBusy(false);
                }}
                disabled={oauthBusy || syncing}
                style={{...S.primaryBtn, flex: 1, opacity: (oauthBusy || syncing) ? 0.6 : 1}}
              >
                {(oauthBusy || syncing) ? <Loader2 size={16} style={{animation: 'spin 1s linear infinite'}} /> : <Activity size={16} />}
                Sync now
              </button>
              <button
                onClick={async () => {
                  if (confirm('Disconnect Whoop? Your existing data stays.')) {
                    await onDisconnectWhoop();
                  }
                }}
                style={{...S.secondaryBtn, padding: '13px 18px'}}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              onClick={() => { window.location.href = '/api/whoop/auth-url'; }}
              style={{...S.primaryBtn, flex: 1}}
            >
              <Activity size={16} /> Connect Whoop
            </button>
          )}
        </div>
      </div>

      {/* Sheet sync card - legacy fallback */}
      <div style={{...S.targetCard, marginBottom: 16, padding: '16px 18px'}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12}}>
          <div style={{flex: 1, minWidth: 0}}>
            <div style={{fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em', color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 4}}>
              {sheetUrl ? 'Auto-sync via Sheet' : 'Or: Sheet sync'}
            </div>
            <div style={{fontSize: 13, color: sheetUrl ? 'var(--text)' : 'var(--text-dim)', lineHeight: 1.4}}>
              {sheetUrl
                ? 'Pulls fresh recovery + calorie burn from your Google Sheet on every open.'
                : 'Alternative: pipe Whoop into a Google Sheet (Apps Script) and read it here. Use only if OAuth doesn\'t work for you.'}
            </div>
          </div>
          <div style={{display: 'flex', flexDirection: 'column', gap: 6}}>
            {sheetUrl ? (
              <button onClick={handleSync} disabled={syncing} style={{...S.iconBtn, padding: 10}}>
                {syncing ? <Loader2 size={14} style={{animation: 'spin 1s linear infinite'}} /> : <Activity size={14} />}
              </button>
            ) : null}
            <button onClick={() => setShowSheetSetup(true)} style={{...S.iconBtn, padding: 10}}>
              <Settings size={14} />
            </button>
          </div>
        </div>
        {!sheetUrl && (
          <button onClick={() => setShowHelp(true)} style={{
            marginTop: 12, background: 'none', border: 'none', color: 'var(--accent)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
            textTransform: 'uppercase', cursor: 'pointer', padding: 0, fontWeight: 600,
          }}>
            Show me how →
          </button>
        )}
      </div>

      {whoop.length === 0 ? (
        <div style={S.emptyCard}>
          <div style={{fontFamily: 'var(--display)', fontSize: 22, fontWeight: 400, marginBottom: 6, fontStyle: 'italic'}}>No Whoop data yet</div>
          <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 20}}>
            Connect your Sheet above for auto-sync, or import a CSV manually.
          </div>
          <button onClick={() => fileRef.current?.click()} style={S.secondaryBtn} disabled={importing}>
            {importing ? <Loader2 size={16} style={{animation: 'spin 1s linear infinite'}} /> : <Upload size={16} />}
            Import CSV
          </button>
        </div>
      ) : (
        <>
          {/* Trend cards */}
          <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18}}>
            <TrendCard label="HRV trend" value={hrvTrend} unit="ms" period="7d vs prior 7d" goodWhen="up" />
            <TrendCard label="RHR trend" value={rhrTrend} unit="bpm" period="7d vs prior 7d" goodWhen="down" />
          </div>

          {/* Recovery strip */}
          <div style={S.recoveryStripCard}>
            <div style={S.recoveryStripHeader}>Last 14 days</div>
            <div style={S.recoveryStrip}>
              {recent.slice().reverse().map((d, i) => {
                const band = recoveryBand(d.recovery);
                const color = band === 'green' ? 'var(--accent)' : band === 'yellow' ? '#fbbf24' : 'var(--bad)';
                const h = Math.max(8, (d.recovery / 100) * 60);
                return (
                  <div key={i} style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flex: 1}}>
                    <div style={{width: '100%', height: 60, display: 'flex', alignItems: 'flex-end', justifyContent: 'center'}}>
                      <div style={{width: '70%', height: h, background: color, borderRadius: 2, opacity: 0.85}} />
                    </div>
                    <div style={{fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--text-faint)'}}>{new Date(d.date).getDate()}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Recent days list */}
          <div style={{...S.sectionLabel, marginTop: 24}}>Recent days</div>
          {recent.slice(0, 7).map(d => (
            <div key={d.date} style={S.recoveryRow}>
              <div style={{flex: 1}}>
                <div style={{fontWeight: 500, fontSize: 14}}>{fmtDate(d.date)}</div>
                <div style={{fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 2}}>
                  HRV {Math.round(d.hrv || 0)} · RHR {Math.round(d.rhr || 0)} · Strain {(d.strain || 0).toFixed(1)}
                  {d.burn ? ` · ${Math.round(d.burn).toLocaleString()} kcal` : ''}
                </div>
              </div>
              <div style={{
                fontFamily: 'var(--mono)',
                fontSize: 18,
                fontWeight: 600,
                color: recoveryBand(d.recovery) === 'green' ? 'var(--accent)' : recoveryBand(d.recovery) === 'yellow' ? '#fbbf24' : 'var(--bad)',
              }}>{Math.round(d.recovery)}</div>
            </div>
          ))}

          <div style={{display: 'flex', gap: 10, marginTop: 20}}>
            <button onClick={() => fileRef.current?.click()} style={{...S.secondaryBtn, flex: 1}} disabled={importing}>
              {importing ? <Loader2 size={14} style={{animation: 'spin 1s linear infinite'}} /> : <Upload size={14} />} Manual CSV
            </button>
            <button onClick={() => { if (confirm('Clear all Whoop data?')) onClear(); }} style={{...S.secondaryBtn, flex: 1}}>
              <Trash2 size={14} /> Clear
            </button>
          </div>
        </>
      )}

      {importMsg && <div style={{marginTop: 14, padding: 12, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, fontSize: 13, color: 'var(--text-dim)'}}>{importMsg}</div>}
      <input ref={fileRef} type="file" accept=".csv,text/csv" style={{display: 'none'}} onChange={e => handleFile(e.target.files?.[0])} />

      {showSheetSetup && (
        <SheetSetupModal
          currentUrl={sheetUrl}
          onClose={() => setShowSheetSetup(false)}
          onSave={async (url) => {
            const result = await onSaveSheetUrl(url);
            setImportMsg(result.msg);
            setShowSheetSetup(false);
          }}
          onShowHelp={() => { setShowSheetSetup(false); setShowHelp(true); }}
        />
      )}
      {showHelp && <ZapierHelpModal onClose={() => setShowHelp(false)} onConnect={() => { setShowHelp(false); setShowSheetSetup(true); }} />}
    </div>
  );
}

function SheetSetupModal({ currentUrl, onClose, onSave, onShowHelp }) {
  const [url, setUrl] = useState(currentUrl || '');
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    if (!url.trim()) {
      // Empty = disconnect
      onSave('');
      return;
    }
    if (!sheetUrlToCsv(url)) {
      setError('Doesn\'t look like a Google Sheets URL. Should start with docs.google.com/spreadsheets/');
      return;
    }
    setValidating(true);
    try {
      // Quick test fetch to validate access
      const csvUrl = sheetUrlToCsv(url);
      const res = await fetch(csvUrl);
      if (!res.ok) {
        setError('Can\'t access this Sheet. Make sure sharing is set to "Anyone with the link can view".');
        setValidating(false);
        return;
      }
      onSave(url.trim());
    } catch (e) {
      setError('Network error. Try again.');
      setValidating(false);
    }
  };

  return (
    <div style={S.modal}>
      <div style={S.modalContent}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>{currentUrl ? 'Sheet connection' : 'Connect Google Sheet'}</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          <div style={{marginBottom: 18}}>
            <label style={S.fieldLabel}>Sheet URL</label>
            <div style={S.fieldHint}>Paste the share link from your Whoop → Sheet Zapier flow.</div>
            <input
              style={S.input}
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
            />
          </div>
          {error && <div style={S.errorBox}>{error}</div>}
          <button onClick={onShowHelp} style={{
            background: 'none', border: 'none', color: 'var(--accent)',
            fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
            textTransform: 'uppercase', cursor: 'pointer', padding: 0,
            fontWeight: 600, marginBottom: 18, display: 'block',
          }}>
            How do I set this up? →
          </button>
          <div style={{display: 'flex', gap: 10}}>
            {currentUrl && (
              <button onClick={() => onSave('')} style={{...S.secondaryBtn, flex: 1}}>Disconnect</button>
            )}
            <button onClick={save} disabled={validating} style={{...S.primaryBtn, flex: currentUrl ? 1 : 'none', width: currentUrl ? 'auto' : '100%'}}>
              {validating ? <Loader2 size={16} style={{animation: 'spin 1s linear infinite'}} /> : <Check size={16} />}
              {currentUrl ? 'Update' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ZapierHelpModal({ onClose, onConnect }) {
  const steps = [
    { n: '01', t: 'Copy the template Sheet', d: 'Visit github.com/pelo-tech/whoop-google-sheets. Follow their README to make a copy of the template Google Sheet into your own Drive. It comes pre-wired with the right columns and the Apps Script attached.' },
    { n: '02', t: 'Enter your Whoop login', d: 'On the Sheet\'s "Config" tab, paste your Whoop email + password (stays in your own Sheet, never leaves Google). Run the auth function from the menu — this gets your access token.' },
    { n: '03', t: 'Run the sync', d: 'From the Sheet menu: Whoop → Sync. Pulls the last ~30 days of cycles: recovery, HRV, RHR, strain, sleep, and calorie burn.' },
    { n: '04', t: 'Set a daily trigger', d: 'In the Apps Script editor, add a time-based trigger: run sync() daily at 7 AM. Now your Sheet auto-updates every morning.' },
    { n: '05', t: 'Share for read access', d: 'Sheet → Share → General access → "Anyone with the link" → Viewer. Copy the link.' },
    { n: '06', t: 'Paste the Sheet URL here', d: 'Come back, hit Connect, paste your Sheet URL. Protocol auto-pulls from it on every open.' },
  ];

  return (
    <div style={S.modal}>
      <div style={{...S.modalContent, maxHeight: '92vh'}}>
        <div style={S.modalHeader}>
          <div style={S.modalTitle}>Whoop auto-sync setup</div>
          <button onClick={onClose} style={S.iconBtn}><X size={18} /></button>
        </div>
        <div style={{padding: '0 24px 28px'}}>
          <div style={{color: 'var(--text-dim)', fontSize: 13, marginBottom: 20, lineHeight: 1.5}}>
            One-time setup, ~15 min. Uses the open-source <strong style={{color: 'var(--text)'}}>pelo-tech/whoop-google-sheets</strong> project — a Google Apps Script that pulls your Whoop data directly into a Sheet. <strong style={{color: 'var(--text)'}}>Completely free</strong>, no Zapier/Make required.
          </div>
          {steps.map(s => (
            <div key={s.n} style={{display: 'flex', gap: 14, marginBottom: 18, paddingBottom: 18, borderBottom: '1px solid var(--line)'}}>
              <div style={{
                fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600,
                color: 'var(--accent)', letterSpacing: '0.1em', flexShrink: 0,
                width: 24, paddingTop: 2,
              }}>{s.n}</div>
              <div style={{flex: 1}}>
                <div style={{fontWeight: 600, fontSize: 14, marginBottom: 4, letterSpacing: '-0.01em'}}>{s.t}</div>
                <div style={{fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5}}>{s.d}</div>
              </div>
            </div>
          ))}
          <div style={{
            background: 'var(--bg-elev-2)', border: '1px solid var(--line)',
            borderRadius: 10, padding: 14, fontSize: 12,
            color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 20,
          }}>
            <div style={{color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', marginBottom: 6, fontWeight: 600}}>Heads up</div>
            Whoop's "Energy burned" comes through as a value the app already knows how to parse. After step 3, check that your Sheet has a column with calorie burn data — that's what drives the per-day target.
          </div>
          <button onClick={onConnect} style={{...S.primaryBtn, width: '100%'}}>
            I'm ready, paste my Sheet URL <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function TrendCard({ label, value, unit, period, goodWhen }) {
  if (value === null) {
    return (
      <div style={S.trendCard}>
        <div style={S.scanCardLabel}>{label}</div>
        <div style={{...S.scanStatValue, color: 'var(--text-faint)'}}>—</div>
        <div style={S.scanStatLabel}>Need 14d</div>
      </div>
    );
  }
  const isGood = goodWhen === 'up' ? value > 0 : value < 0;
  const color = Math.abs(value) < 1 ? 'var(--text-dim)' : isGood ? 'var(--good)' : 'var(--bad)';
  const sign = value > 0 ? '+' : '';
  return (
    <div style={S.trendCard}>
      <div style={S.scanCardLabel}>{label}</div>
      <div style={{...S.scanStatValue, color}}>{sign}{value.toFixed(1)}<span style={S.scanStatUnit}>{unit}</span></div>
      <div style={S.scanStatLabel}>{period}</div>
    </div>
  );
}

// ============ SETTINGS ============
function SettingsView({ profile, savedMeals, onSave, onDeleteSaved }) {
  const [weight, setWeight] = useState(String(profile.weightLbs || ''));
  const [maintenance, setMaintenance] = useState(String(profile.maintenance || ''));
  // Match plan id from saved profile, fallback to closest by deficit, default to 'steady'
  const initialPlan = profile.planId || (() => {
    const d = profile.deficit || 350;
    let best = GOAL_PLANS[1];
    let bestDiff = Math.abs(best.deficit - d);
    for (const p of GOAL_PLANS) {
      const diff = Math.abs(p.deficit - d);
      if (diff < bestDiff) { best = p; bestDiff = diff; }
    }
    return best.id;
  })();
  const [planId, setPlanId] = useState(initialPlan);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    const plan = GOAL_PLANS.find(p => p.id === planId) || GOAL_PLANS[1];
    await onSave({
      weightLbs: parseFloat(weight),
      maintenance: parseFloat(maintenance),
      deficit: plan.deficit,
      planId: plan.id,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div style={S.view}>
      <div style={S.sectionLabel}>Plan</div>

      <div style={{display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 24}}>
        {GOAL_PLANS.map(plan => {
          const isSelected = planId === plan.id;
          return (
            <button
              key={plan.id}
              onClick={() => setPlanId(plan.id)}
              style={{
                textAlign: 'left',
                background: isSelected ? 'rgba(212,255,63,0.05)' : 'var(--bg-elev)',
                border: `1px solid ${isSelected ? 'var(--accent)' : 'var(--line)'}`,
                borderRadius: 12,
                padding: '12px 14px',
                cursor: 'pointer',
                fontFamily: 'var(--sans)',
                color: 'var(--text)',
              }}
            >
              <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4}}>
                <span style={{fontWeight: 600, fontSize: 14}}>{plan.label}</span>
                <span style={{fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)'}}>
                  {plan.deficit > 0 ? `−${plan.deficit}` : '±0'} kcal · {plan.weeklyLoss > 0 ? `~${plan.weeklyLoss} lb/wk` : 'no loss'}
                </span>
              </div>
              <div style={{fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4}}>
                {plan.blurb}
              </div>
            </button>
          );
        })}
      </div>

      <div style={S.sectionLabel}>Profile</div>

      <div style={{marginBottom: 18}}>
        <label style={S.fieldLabel}>Body weight</label>
        <div style={S.inputWrap}>
          <input style={S.input} type="number" value={weight} onChange={e => setWeight(e.target.value)} />
          <span style={S.inputSuffix}>lbs</span>
        </div>
      </div>

      <div style={{marginBottom: 24}}>
        <label style={S.fieldLabel}>Maintenance calories <span style={{color: 'var(--text-faint)', fontSize: 9, marginLeft: 4}}>(FALLBACK)</span></label>
        <div style={S.fieldHint}>Used only when Whoop data isn't available for the day. Whoop's actual daily burn is used when synced.</div>
        <div style={S.inputWrap}>
          <input style={S.input} type="number" value={maintenance} onChange={e => setMaintenance(e.target.value)} />
          <span style={S.inputSuffix}>kcal</span>
        </div>
      </div>

      <button onClick={save} style={{...S.primaryBtn, width: '100%'}}>
        {saved ? <><Check size={16} /> Saved</> : 'Save changes'}
      </button>

      {/* Saved meals library */}
      {savedMeals && savedMeals.length > 0 && (
        <>
          <div style={{...S.sectionLabel, marginTop: 32}}>Meal library · {savedMeals.length}</div>
          <div style={{maxHeight: 240, overflowY: 'auto'}}>
            {[...savedMeals].sort((a, b) => (b.uses || 0) - (a.uses || 0)).map(s => (
              <div key={s.id} style={S.scanRow}>
                <div style={{flex: 1, minWidth: 0}}>
                  <div style={{fontWeight: 500, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>{s.name}</div>
                  <div style={{fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 2}}>
                    {Math.round(s.calories)} kcal · {Math.round(s.protein)}P · used {s.uses || 0}×
                  </div>
                </div>
                <button onClick={() => { if (confirm(`Remove "${s.name}"?`)) onDeleteSaved(s.id); }} style={S.iconBtn}>
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div style={{marginTop: 32, padding: 16, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 12}}>
        <div style={{fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em', textTransform: 'uppercase', color: 'var(--text-dim)', marginBottom: 8}}>How it works</div>
        <div style={{fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.6}}>
          <strong style={{color: 'var(--text)'}}>Daily target = Whoop burn − deficit.</strong> Whoop already accounts for your strain, so the harder you train, the more you eat. No static maintenance number needed when synced.<br/><br/>
          <strong style={{color: 'var(--text)'}}>Recovery scaling.</strong> Green ({'>'}67): full deficit. Yellow (34–66): 40% deficit. Red ({'<'}34): maintenance, no cut.<br/><br/>
          <strong style={{color: 'var(--text)'}}>Fallback mode.</strong> Without Whoop data, uses your maintenance estimate plus a strain bump (+200 kcal at strain 14, +350 at 17).<br/><br/>
          <strong style={{color: 'var(--text)'}}>Protein.</strong> Fixed at 1g per lb of bodyweight to protect lean mass while cutting.
        </div>
      </div>
    </div>
  );
}

// ============ STYLES ============
const S = {
  app: {
    background: 'var(--bg)',
    minHeight: '100vh',
    color: 'var(--text)',
    fontFamily: 'var(--sans)',
  },
  loadingScreen: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: 'var(--bg)',
  },
  header: {
    padding: '20px 20px 14px',
    borderBottom: '1px solid var(--line)',
    position: 'sticky',
    top: 0,
    background: 'rgba(10,11,13,0.92)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    zIndex: 50,
  },
  headerRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' },
  brand: { fontFamily: 'var(--display)', fontWeight: 500, fontSize: 22, letterSpacing: '-0.02em' },
  datePill: {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.1em',
    color: 'var(--text-dim)', textTransform: 'uppercase',
  },
  viewWrap: { paddingBottom: 20 },
  view: { padding: 20 },
  tabBar: {
    position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
    width: '100%', maxWidth: 480, background: 'rgba(10,11,13,0.95)',
    backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
    borderTop: '1px solid var(--line)',
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', zIndex: 100,
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  tab: {
    background: 'none', border: 'none', padding: '14px 4px',
    fontFamily: 'var(--mono)', fontSize: 8.5, letterSpacing: '0.14em',
    textTransform: 'uppercase', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    transition: 'color 0.15s',
  },

  // Target card
  targetCard: {
    background: 'var(--bg-elev)',
    border: '1px solid var(--line)',
    borderRadius: 18,
    padding: '24px 22px 20px',
    marginBottom: 14,
    position: 'relative',
    overflow: 'hidden',
  },
  targetCardGlow: {
    position: 'absolute', top: 0, right: 0, width: 240, height: 240,
    background: 'radial-gradient(circle, rgba(212,255,63,0.08), transparent 60%)',
    pointerEvents: 'none',
  },
  targetLabel: {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em',
    color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 10,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    position: 'relative', zIndex: 1,
  },
  targetNumber: {
    fontFamily: 'var(--display)', fontSize: 64, fontWeight: 400,
    lineHeight: 1, letterSpacing: '-0.04em', marginBottom: 6,
    position: 'relative', zIndex: 1,
  },
  targetUnit: {
    fontFamily: 'var(--sans)', fontSize: 16, color: 'var(--text-dim)',
    marginLeft: 8, fontStyle: 'italic', fontWeight: 400,
  },
  targetSub: { fontSize: 13, color: 'var(--text-dim)', position: 'relative', zIndex: 1 },
  progressTrack: {
    height: 4, background: 'var(--line)', borderRadius: 2, overflow: 'hidden',
  },
  progressFill: {
    height: '100%', background: 'linear-gradient(90deg, var(--accent-dim), var(--accent))',
    borderRadius: 2, transition: 'width 0.4s ease',
  },
  progressMeta: {
    display: 'flex', justifyContent: 'space-between', marginTop: 8,
    fontSize: 12, color: 'var(--text-dim)',
  },

  // Macros
  macroGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 },
  macroPill: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 12, padding: '12px 14px',
  },
  macroPillHighlight: {
    border: '1px solid rgba(212,255,63,0.25)',
    background: 'linear-gradient(180deg, rgba(212,255,63,0.04), var(--bg-elev))',
  },
  macroHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  macroLabel: {
    fontFamily: 'var(--mono)', fontSize: 9, letterSpacing: '0.12em',
    color: 'var(--text-dim)', textTransform: 'uppercase',
  },
  macroValue: {
    fontFamily: 'var(--display)', fontSize: 22, fontWeight: 500,
    lineHeight: 1, letterSpacing: '-0.02em',
  },
  macroUnit: { fontSize: 11, color: 'var(--text-dim)', marginLeft: 2, fontStyle: 'italic' },
  macroTarget: { fontSize: 10, color: 'var(--text-faint)', marginTop: 4, fontFamily: 'var(--mono)' },

  // Add meal button
  addMealBtn: {
    width: '100%',
    background: 'var(--accent)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 14,
    padding: '16px 20px',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    fontFamily: 'var(--sans)',
    letterSpacing: '-0.01em',
  },

  // Quick stats row (weight + strain)
  quickStatsRow: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 8,
    marginBottom: 14,
  },
  quickStatsRow3: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr 1fr',
    gap: 8,
    marginBottom: 14,
  },
  quickStat: {
    background: 'var(--bg-elev)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    padding: '10px 12px',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    cursor: 'pointer',
    color: 'var(--text)',
    fontFamily: 'var(--sans)',
    minWidth: 0,
  },
  quickStatLabel: {
    fontSize: 10,
    color: 'var(--text-dim)',
    fontFamily: 'var(--mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  quickStatValue: {
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    marginLeft: 'auto',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  // Add meal row (3 buttons)
  addMealRow: {
    display: 'grid',
    gridTemplateColumns: '1fr auto auto',
    gap: 8,
  },
  addMealPrimary: {
    background: 'var(--accent)',
    color: 'var(--bg)',
    border: 'none',
    borderRadius: 14,
    padding: '15px 20px',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    fontFamily: 'var(--sans)',
    letterSpacing: '-0.01em',
  },
  addMealSecondary: {
    background: 'var(--bg-elev)',
    color: 'var(--text)',
    border: '1px solid var(--line-bright)',
    borderRadius: 14,
    width: 50,
    height: 50,
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--sans)',
  },

  // Saved meals
  savedMealRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  savedMealMain: {
    flex: 1,
    background: 'var(--bg-elev-2)',
    border: '1px solid var(--line)',
    borderRadius: 10,
    padding: '12px 14px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: 'var(--text)',
    fontFamily: 'var(--sans)',
    textAlign: 'left',
  },

  // Stats (insights)
  statsGrid2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 10,
    marginBottom: 14,
  },
  statCard: {
    background: 'var(--bg-elev)',
    border: '1px solid var(--line)',
    borderRadius: 14,
    padding: 16,
  },
  // Meal cards
  sectionLabel: {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.18em',
    color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 12,
  },
  emptyState: {
    padding: '24px 20px', textAlign: 'center', color: 'var(--text-faint)',
    fontSize: 13, border: '1px dashed var(--line)', borderRadius: 12,
  },
  emptyCard: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 16, padding: '32px 24px', textAlign: 'center',
  },
  mealCard: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 12, padding: 12, marginBottom: 8,
    display: 'flex', alignItems: 'center', gap: 12,
  },
  mealPhoto: {
    width: 52, height: 52, borderRadius: 8, objectFit: 'cover',
    flexShrink: 0,
  },
  mealName: {
    fontWeight: 500, fontSize: 14, marginBottom: 2,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  },
  mealMeta: { fontSize: 11, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 },
  mealDot: { color: 'var(--text-faint)' },

  // Modals
  modal: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
  },
  modalContent: {
    background: 'var(--bg-elev)', borderRadius: '20px 20px 0 0',
    width: '100%', maxWidth: 480, maxHeight: '90vh', overflowY: 'auto',
    border: '1px solid var(--line)', borderBottom: 'none',
  },
  modalHeader: {
    padding: '18px 24px 12px', display: 'flex',
    justifyContent: 'space-between', alignItems: 'center',
  },
  modalTitle: { fontFamily: 'var(--display)', fontSize: 22, fontWeight: 500, letterSpacing: '-0.02em' },

  // Form
  fieldLabel: {
    display: 'block', fontFamily: 'var(--mono)', fontSize: 10,
    letterSpacing: '0.15em', color: 'var(--text-dim)',
    textTransform: 'uppercase', marginBottom: 6,
  },
  fieldLabelSm: {
    display: 'block', fontFamily: 'var(--mono)', fontSize: 9,
    letterSpacing: '0.12em', color: 'var(--text-dim)',
    textTransform: 'uppercase', marginBottom: 4,
  },
  fieldHint: { fontSize: 12, color: 'var(--text-faint)', marginBottom: 8 },
  inputWrap: { position: 'relative' },
  input: {
    width: '100%', background: 'var(--bg-elev-2)', border: '1px solid var(--line-bright)',
    borderRadius: 10, padding: '12px 14px', color: 'var(--text)',
    fontSize: 16, fontFamily: 'var(--sans)', outline: 'none',
  },
  inputSm: {
    width: '100%', background: 'var(--bg-elev-2)', border: '1px solid var(--line-bright)',
    borderRadius: 8, padding: '10px 12px', color: 'var(--text)',
    fontSize: 15, fontFamily: 'var(--mono)', outline: 'none',
  },
  inputSuffix: {
    position: 'absolute', right: 14, top: '50%', transform: 'translateY(-50%)',
    fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-faint)',
    textTransform: 'uppercase', letterSpacing: '0.1em', pointerEvents: 'none',
  },
  macroEditGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },

  // Buttons
  primaryBtn: {
    background: 'var(--accent)', color: 'var(--bg)',
    border: 'none', borderRadius: 12, padding: '14px 20px',
    fontWeight: 600, fontSize: 14, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: 'var(--sans)', letterSpacing: '-0.01em',
  },
  secondaryBtn: {
    background: 'var(--bg-elev-2)', color: 'var(--text)',
    border: '1px solid var(--line-bright)', borderRadius: 12,
    padding: '13px 20px', fontWeight: 500, fontSize: 14, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontFamily: 'var(--sans)',
  },
  iconBtn: {
    background: 'var(--bg-elev-2)', color: 'var(--text-dim)',
    border: '1px solid var(--line)', borderRadius: 8,
    padding: 8, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },

  // Capture
  captureBox: {
    border: '2px dashed var(--line-bright)', borderRadius: 16,
    padding: '40px 20px', textAlign: 'center', cursor: 'pointer',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    background: 'var(--bg-elev-2)',
  },

  // AI note
  aiNote: {
    background: 'var(--bg-elev-2)', border: '1px solid var(--line)',
    borderRadius: 10, padding: '10px 14px', fontSize: 12,
    color: 'var(--text-dim)', marginBottom: 16,
    fontFamily: 'var(--mono)',
  },
  errorBox: {
    background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.25)',
    borderRadius: 10, padding: '10px 14px', fontSize: 12,
    color: 'var(--bad)', marginBottom: 16,
  },

  // Scans
  scanLatestCard: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 16, padding: 18,
  },
  scanCardLabel: {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
    color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 14,
  },
  scanStatGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 },
  scanStatCell: { },
  scanStatLabel: { fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--mono)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 },
  scanStatValue: {
    fontFamily: 'var(--display)', fontSize: 28, fontWeight: 500,
    lineHeight: 1, letterSpacing: '-0.02em',
  },
  scanStatUnit: { fontSize: 12, color: 'var(--text-dim)', marginLeft: 3, fontStyle: 'italic' },
  scanStatDelta: { fontSize: 11, marginTop: 4, fontFamily: 'var(--mono)', fontWeight: 600 },
  scanRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '12px 0', borderBottom: '1px solid var(--line)',
  },

  // Recovery
  recoveryStripCard: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 16, padding: 18,
  },
  recoveryStripHeader: {
    fontFamily: 'var(--mono)', fontSize: 10, letterSpacing: '0.15em',
    color: 'var(--text-dim)', textTransform: 'uppercase', marginBottom: 14,
  },
  recoveryStrip: { display: 'flex', alignItems: 'flex-end', gap: 4, height: 80 },
  recoveryRow: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 0', borderBottom: '1px solid var(--line)',
  },
  trendCard: {
    background: 'var(--bg-elev)', border: '1px solid var(--line)',
    borderRadius: 14, padding: 16,
  },
};

// ============ GLOBAL CSS ============
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&family=JetBrains+Mono:wght@400;500;600&family=Inter+Tight:wght@400;500;600;700&display=swap');
      :root {
        --bg: #0a0b0d;
        --bg-elev: #111315;
        --bg-elev-2: #16191c;
        --line: #1f2328;
        --line-bright: #2a2f36;
        --text: #f4f4f2;
        --text-dim: #8b9098;
        --text-faint: #4a4f57;
        --accent: #d4ff3f;
        --accent-dim: #9eb82e;
        --warn: #ff7a45;
        --good: #4ade80;
        --bad: #f87171;
        --display: 'Fraunces', serif;
        --sans: 'Inter Tight', system-ui, sans-serif;
        --mono: 'JetBrains Mono', monospace;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0; background: var(--bg); color: var(--text);
        font-family: var(--sans); -webkit-font-smoothing: antialiased;
        max-width: 480px; margin-left: auto; margin-right: auto;
        padding-bottom: calc(72px + env(safe-area-inset-bottom));
      }
      input:focus { border-color: var(--accent) !important; }
      button:active { transform: scale(0.98); }
      @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    `}</style>
  );
}
