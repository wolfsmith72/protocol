// /api/whoop/status.js
// Lightweight check the UI calls to know if Whoop is connected (without exposing the token).

const COOKIE_NAME = 'whoop_tokens';

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export default async function handler(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const connected = !!cookies[COOKIE_NAME];
  return res.status(200).json({ connected });
}
