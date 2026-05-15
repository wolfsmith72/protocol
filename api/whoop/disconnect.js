// /api/whoop/disconnect.js
// Clears the Whoop tokens cookie. Optionally revokes the access token at Whoop.

import crypto from 'crypto';

const COOKIE_NAME = 'whoop_tokens';

function decrypt(blob, key) {
  try {
    const [ivHex, ctHex, tagHex] = blob.split('.');
    const iv = Buffer.from(ivHex, 'hex');
    const ct = Buffer.from(ctHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cookies = parseCookies(req.headers.cookie || '');
  const blob = cookies[COOKIE_NAME];
  const key = process.env.TOKEN_ENCRYPTION_KEY;

  // Try to revoke at Whoop's side (fire and forget)
  if (blob && key) {
    const tokens = decrypt(blob, key);
    if (tokens?.access_token) {
      try {
        await fetch('https://api.prod.whoop.com/developer/v2/user/access', {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
      } catch {}
    }
  }

  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
  return res.status(200).json({ ok: true });
}
