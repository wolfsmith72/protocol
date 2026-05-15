// /api/whoop/auth-url.js
// Step 1 of OAuth: generates the authorize URL and redirects the user to Whoop's login.
// After consent, Whoop redirects back to /api/whoop/callback with a code.

import crypto from 'crypto';

export default async function handler(req, res) {
  const clientId = process.env.WHOOP_CLIENT_ID;
  const redirectUri = process.env.WHOOP_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: 'Whoop env vars not configured (WHOOP_CLIENT_ID, WHOOP_REDIRECT_URI)' });
  }

  // Anti-CSRF state value, stored in a short-lived cookie and verified on callback
  const state = crypto.randomBytes(16).toString('hex');

  const scopes = [
    'read:recovery',
    'read:cycles',
    'read:workout',
    'read:sleep',
    'read:profile',
    'read:body_measurement',
    'offline', // for refresh token
  ].join(' ');

  const url = new URL('https://api.prod.whoop.com/oauth/oauth2/auth');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', state);

  res.setHeader('Set-Cookie', `whoop_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`);
  res.writeHead(302, { Location: url.toString() });
  res.end();
}
