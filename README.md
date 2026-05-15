# Protocol

Lean phase tracking app. Recovery-aware calorie targets driven by Whoop data, photo-based food logging, DEXA + daily weight tracking.

## Deploy to Vercel (5–10 min)

### 1. Get the code on GitHub

```bash
cd protocol-app
git init
git add .
git commit -m "init"
gh repo create protocol --private --source=. --push
```

If you don't have the `gh` CLI: create a new repo on github.com, then:

```bash
git remote add origin https://github.com/YOUR_USERNAME/protocol.git
git branch -M main
git push -u origin main
```

### 2. Generate icons

You need three PNGs in `public/`:
- `icon-180.png` (180×180, for iOS home screen)
- `icon-192.png` (192×192)
- `icon-512.png` (512×512)

Easiest path: open `public/icon-source.html` in your browser, screenshot or use a tool like https://realfavicongenerator.net to export the sizes. Or design something in Figma — you mentioned wanting to design the Ravioli logo, this is the same workflow.

Drop the three PNGs in `public/` and commit.

### 3. Deploy on Vercel

1. Go to vercel.com → New Project → Import your GitHub repo
2. Framework preset: **Vite** (auto-detected)
3. Before deploying, click **Environment Variables** and add:
   - Name: `ANTHROPIC_API_KEY`
   - Value: your Anthropic API key from console.anthropic.com
4. Click **Deploy**

You'll get a URL like `protocol-xyz.vercel.app`.

### 4. Add to iPhone home screen

1. Open the URL in **Safari** (must be Safari, not Chrome)
2. Tap the Share button
3. Scroll down → **Add to Home Screen**
4. Tap **Add**

The app launches fullscreen with no browser chrome. Pull-to-refresh works. Photos open the native camera. It feels like a real app.

### 5. Use a custom domain (optional)

In Vercel project settings → Domains, add `protocol.yourdomain.com`. Free with Vercel; you handle the DNS.

## Local dev

```bash
npm install
npm run dev
```

Note: the `/api/analyze-meal` route won't work locally unless you use `vercel dev` (install with `npm i -g vercel`). For local testing without the API, the manual entry flow works fine.

## What's saved where

All your data lives in **localStorage** on your phone — never sent anywhere except the meal photos you choose to analyze. If you clear Safari data or switch phones, you lose your history. Future improvement: add an export/import button on Setup.

## Anthropic API cost

Each meal photo analysis costs around $0.01–0.03. At 3–5 meals/day, that's ~$2–5/month. Cap your monthly spend at console.anthropic.com → Billing → Spend limit.
