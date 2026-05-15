# Whoop OAuth Setup

Real Whoop API integration. ~10 minutes one-time setup.

## What this does

Replaces CSV uploads / Google Sheets with a direct connection to Whoop's official API. Every time you open Protocol, it pulls your latest cycles, recovery, sleep, and calorie burn — automatically.

## Step 1: Create a Whoop developer app (5 min)

1. Go to **developer-dashboard.whoop.com**
2. Sign in with your Whoop account (same one you use in the app)
3. Click **Create New App**
4. Fill it in:
   - **Name**: Protocol (or whatever)
   - **Contact email**: your email
   - **Privacy policy URL**: just use `https://protocol-peach.vercel.app/` (it doesn't validate it for personal use)
   - **Redirect URIs**: this is the important one — set it to exactly:
     ```
     https://protocol-peach.vercel.app/api/whoop/callback
     ```
     (Replace `protocol-peach.vercel.app` with your actual domain if different)
   - **Scopes**: check all 6 read scopes (recovery, cycles, workout, sleep, profile, body_measurement)
5. Click **Create**
6. You'll see your **Client ID** and **Client Secret** — keep this tab open

Since you have fewer than 10 users (just you), Whoop doesn't require any review or approval — the app works immediately.

## Step 2: Generate an encryption key

In Terminal:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Copy the 64-character hex string. This encrypts your Whoop tokens before they're stored.

## Step 3: Add env vars to Vercel

1. Go to **vercel.com** → your protocol project → **Settings** → **Environment Variables**
2. Add these four (one at a time):

| Name | Value |
|---|---|
| `WHOOP_CLIENT_ID` | (from step 1) |
| `WHOOP_CLIENT_SECRET` | (from step 1) |
| `WHOOP_REDIRECT_URI` | `https://protocol-peach.vercel.app/api/whoop/callback` |
| `TOKEN_ENCRYPTION_KEY` | (from step 2) |

Make sure each is set for **Production** (and Preview if you want). Save each.

## Step 4: Redeploy

From the protocol-app folder:

```bash
git add .
git commit -m "Whoop OAuth integration"
git push
```

Vercel auto-deploys in ~60 seconds. Or trigger a redeploy from the Vercel dashboard if you've already pushed the code.

## Step 5: Connect

1. Open Protocol on your phone
2. Whoop tab → tap **Connect Whoop**
3. You'll be redirected to Whoop's login page — sign in
4. Approve the permissions
5. You'll be redirected back to Protocol with "Connected to Whoop. Pulling your data…"
6. Your last 30 days of recovery, strain, and burn data appear immediately

That's it. From now on, opening Protocol auto-syncs anything new from Whoop. No exports, no manual steps.

## Token security

- Your access + refresh tokens live in an **encrypted HttpOnly cookie** on your phone
- The encryption key (`TOKEN_ENCRYPTION_KEY`) only lives on Vercel's server — never sent to the browser
- Tokens auto-refresh in the background when they expire (every hour)
- The Disconnect button revokes the token at Whoop's side and clears the cookie

## Troubleshooting

**"Whoop connect failed: state_mismatch"** — Cookie was cleared between auth start and callback. Try again.

**"refresh_failed" after a while** — Refresh tokens can expire if unused for a long period. Hit Disconnect and reconnect.

**Wrong redirect URI** — Whoop will reject with "redirect_uri_mismatch". The URI in your developer-dashboard.whoop.com app must exactly match `WHOOP_REDIRECT_URI` in Vercel, character for character.
