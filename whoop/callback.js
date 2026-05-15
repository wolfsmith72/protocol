// /api/whoop/callback.js
// Step 2 of OAuth: Whoop redirects back here with a `code`. We exchange it for
// an access token + refresh token, then store both in an encrypted, HttpOnly cookie.

import crypto from 'crypto';

const COOKIE_NAME = 'whoop_tokens';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function encrypt(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${ciphertext.toString('hex')}.${tag.toString('hex')}`;
}

export default async function handler(req, res) {
  const { code, state, error: oauthError } = req.query;

  // Build the absolute base URL of this deployment so we can redirect back to the app
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const appUrl = `${proto}://${host}`;

  if (oauthError) {
    return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=${encodeURIComponent(String(oauthError))}` }).end();
  }
  if (!code) {
    return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=missing_code` }).end();
  }

  // Verify state matches the cookie we set in auth-url
  const cookieState = parseCookies(req.headers.cookie || '').whoop_oauth_state;
  if (!cookieState || cookieState !== state) {
    return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=state_mismatch` }).end();
  }

  const clientId = process.env.WHOOP_CLIENT_ID;
  const clientSecret = process.env.WHOOP_CLIENT_SECRET;
  const redirectUri = process.env.WHOOP_REDIRECT_URI;
  const encryptionKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!clientId || !clientSecret || !redirectUri || !encryptionKey) {
    return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=server_misconfigured` }).end();
  }

  // Exchange code for tokens
  try {
    const tokenResp = await fetch('https://api.prod.whoop.com/oauth/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      console.error('Whoop token exchange failed:', tokenResp.status, txt);
      return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=token_exchange_failed` }).end();
    }

    const tokens = await tokenResp.json();
    // tokens contains: access_token, refresh_token, expires_in, token_type, scope

    const tokenBundle = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    };

    const encrypted = encrypt(JSON.stringify(tokenBundle), encryptionKey);

    // Clear the state cookie, set the tokens cookie
    res.setHeader('Set-Cookie', [
      `whoop_oauth_state=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`,
      `${COOKIE_NAME}=${encrypted}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    ]);

    // Redirect back to the app, with a flag so the UI can show "Connected!"
    res.writeHead(302, { Location: `${appUrl}/?whoop=connected` });
    res.end();
  } catch (e) {
    console.error('Callback error:', e);
    return res.writeHead(302, { Location: `${appUrl}/?whoop=error&reason=server_error` }).end();
  }
}

function parseCookies(header) {
  const out = {};
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  });
  return out;
}
