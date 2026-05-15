// /api/whoop/sync.js
// Reads the encrypted cookie, refreshes the token if expired, pulls cycles +
// recovery + workouts from Whoop, and returns normalized rows matching the
// app's existing Whoop CSV row shape:
// { date, recovery, hrv, rhr, strain, sleep, burn }

import crypto from 'crypto';

const COOKIE_NAME = 'whoop_tokens';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function decrypt(blob, key) {
  const [ivHex, ctHex, tagHex] = blob.split('.');
  if (!ivHex || !ctHex || !tagHex) throw new Error('malformed cookie');
  const iv = Buffer.from(ivHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${ciphertext.toString('hex')}.${tag.toString('hex')}`;
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

async function refreshIfNeeded(tokens, encryptionKey) {
  // Refresh ~2 minutes before expiry to be safe
  if (tokens.expires_at && tokens.expires_at - Date.now() > 2 * 60 * 1000) {
    return { tokens, newCookieValue: null };
  }
  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  const resp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'offline',
    }).toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`refresh failed: ${resp.status} ${txt}`);
  }
  const fresh = await resp.json();
  const updated = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + (fresh.expires_in || 3600) * 1000,
  };
  const newCookieValue = encrypt(JSON.stringify(updated), encryptionKey);
  return { tokens: updated, newCookieValue };
}

async function whoopGET(path, accessToken, params = {}) {
  const url = new URL(`https://api.prod.whoop.com/developer${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Whoop API ${path} failed: ${resp.status} ${txt}`);
  }
  return resp.json();
}

export default async function handler(req, res) {
  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return res.status(500).json({ error: 'server misconfigured' });
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const blob = cookies[COOKIE_NAME];
  if (!blob) {
    return res.status(401).json({ error: 'not_connected' });
  }

  let tokens;
  try {
    tokens = decrypt(blob, encryptionKey);
  } catch (e) {
    return res.status(401).json({ error: 'invalid_token_cookie' });
  }

  let newCookieValue = null;
  try {
    const r = await refreshIfNeeded(tokens, encryptionKey);
    tokens = r.tokens;
    newCookieValue = r.newCookieValue;
  } catch (e) {
    console.error(e);
    return res.status(401).json({ error: 'refresh_failed' });
  }

  // Default: pull last 30 days. Caller can override via ?days=N.
  const days = Math.max(1, Math.min(60, parseInt(req.query.days || '30', 10) || 30));
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 3600 * 1000);

  try {
    // Fetch cycles (gives us strain + kilojoule/calorie burn per day)
    const cycles = [];
    let nextToken;
    let pageCount = 0;
    do {
      const page = await whoopGET('/v2/cycle', tokens.access_token, {
        limit: 25,
        start: start.toISOString(),
        end: end.toISOString(),
        nextToken,
      });
      cycles.push(...(page.records || []));
      nextToken = page.next_token;
      pageCount++;
    } while (nextToken && pageCount < 10);

    // Fetch recoveries (gives us recovery score, HRV, RHR)
    const recoveries = [];
    nextToken = undefined;
    pageCount = 0;
    do {
      const page = await whoopGET('/v2/recovery', tokens.access_token, {
        limit: 25,
        start: start.toISOString(),
        end: end.toISOString(),
        nextToken,
      });
      recoveries.push(...(page.records || []));
      nextToken = page.next_token;
      pageCount++;
    } while (nextToken && pageCount < 10);

    // Index recoveries by cycle_id for joining
    const recoveryByCycle = {};
    for (const r of recoveries) {
      if (r.cycle_id) recoveryByCycle[r.cycle_id] = r;
    }

    // For sleep duration, fetch sleep records and key by cycle_id via the cycle.sleep endpoint.
    // Simpler: pull the sleep collection in the same window.
    const sleeps = [];
    nextToken = undefined;
    pageCount = 0;
    do {
      const page = await whoopGET('/v2/activity/sleep', tokens.access_token, {
        limit: 25,
        start: start.toISOString(),
        end: end.toISOString(),
        nextToken,
      });
      sleeps.push(...(page.records || []));
      nextToken = page.next_token;
      pageCount++;
    } while (nextToken && pageCount < 10);

    const sleepByCycle = {};
    for (const s of sleeps) {
      if (s.nap) continue; // ignore naps
      if (s.cycle_id) sleepByCycle[s.cycle_id] = s;
    }

    // Normalize into rows matching the existing CSV row shape
    const rows = cycles.map((c) => {
      const r = recoveryByCycle[c.id]?.score;
      const s = sleepByCycle[c.id]?.score;
      const kj = c.score?.kilojoule;
      const burn = kj ? Math.round(kj / 4.184) : null;
      const inBedMs = s?.stage_summary?.total_in_bed_time_milli;
      const awakeMs = s?.stage_summary?.total_awake_time_milli;
      const sleepHours = inBedMs ? Math.round(((inBedMs - (awakeMs || 0)) / 3600000) * 100) / 100 : null;
      const date = c.start ? c.start.slice(0, 10) : null;
      return {
        date,
        recovery: r?.recovery_score ?? null,
        hrv: r?.hrv_rmssd_milli ?? null,
        rhr: r?.resting_heart_rate ?? null,
        strain: c.score?.strain ?? null,
        sleep: sleepHours,
        burn,
      };
    }).filter((row) => row.date && row.recovery != null);

    // Sort ascending by date
    rows.sort((a, b) => a.date.localeCompare(b.date));

    // Set refreshed cookie if needed
    if (newCookieValue) {
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${newCookieValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`);
    }

    return res.status(200).json({ rows, days, fetched_at: new Date().toISOString() });
  } catch (e) {
    console.error('Sync error:', e);
    return res.status(500).json({ error: e.message || 'sync failed' });
  }
}
