# KW Volume Breakout Monitor

Live institutional dashboard for Boursa Kuwait volume breakouts.
TradingView Pine indicator → webhook → Postgres → React table with live Yahoo Finance quotes.

## Stack

- **Pine Script** indicator on TradingView (Premium tier required for webhooks)
- **Express** backend (Node 20+) with Postgres
- **React + Vite** frontend
- **Yahoo Finance** for live quotes (`yahoo-finance2` npm package, Kuwait `.KW` symbols)
- **Render** for hosting (single Web Service + free Postgres database)

## Architecture flow

```
TradingView Premium
    │
    │ JSON webhook (alert fires)
    │
    ▼
[POST /webhook/breakout] ──────► Postgres (breakouts table)
                                     ▲
                                     │ JOIN with live_quotes
                                     │
[Background poller every 60s] ───► Postgres (live_quotes table)
        ▲
        │ fetches from Yahoo Finance
        │
        ▼
[GET /api/breakouts] ◄──── React frontend (auto-refresh every 30s)
```

## Deployment to Render

### 1. Push this repo to GitHub
```bash
cd kw-breakout
git init
git add .
git commit -m "initial commit"
git remote add origin https://github.com/YOUR-USERNAME/kw-breakout.git
git push -u origin main
```

### 2. Create the Render services
1. Go to [Render Dashboard](https://dashboard.render.com) → **New +** → **Blueprint**
2. Connect your GitHub repo
3. Render reads `render.yaml` and provisions:
   - Web Service `kw-breakout`
   - Postgres `kw-breakout-db` (free tier)
4. Click **Apply** — first build takes ~5 minutes

### 3. Get your secrets
After deploy, in Render dashboard:
- Go to your web service → **Environment**
- Copy the value of `WEBHOOK_SECRET` (auto-generated random string)
- Note your service URL: `https://kw-breakout-XXXX.onrender.com`

### 4. Configure TradingView alerts

For **each** Kuwait stock you want to monitor:

1. Open the chart, add the **KW Volume Breakout vs ADV** indicator (`pine_script.pine`)
2. **Edit the Pine Script ONCE before adding** — find this line:
   ```
   "secret":"REPLACE_WITH_YOUR_SECRET"
   ```
   Replace `REPLACE_WITH_YOUR_SECRET` with the `WEBHOOK_SECRET` value from Render.
3. Right-click chart → **Add alert**
4. Condition: select the indicator, condition = `Any alert() function call`
5. **Webhook URL**: `https://YOUR-RENDER-URL.onrender.com/webhook/breakout`
6. Message: leave default (the Pine `alert()` call sends the JSON automatically)
7. Save

Repeat for all watchlist stocks (or use TradingView's "Apply to all" if available on your tier).

### 5. View the dashboard
Open `https://YOUR-RENDER-URL.onrender.com` in any browser. Public URL — share freely.

## Local development

```bash
# 1. Install Postgres locally and create a database
createdb kw_breakout

# 2. Backend
cd server
cp ../.env.example ../.env
# Edit ../.env with your local DATABASE_URL
npm install
npm run dev

# 3. Frontend (separate terminal)
cd client
npm install
npm run dev
# Open http://localhost:5173
```

## Pine Script: webhook setup detail

The script's `alert()` call emits a JSON like:
```json
{
  "ticker": "NBK",
  "exchange": "KSE",
  "price": 0.865,
  "cum_vol": 4750000,
  "threshold": 4500000,
  "adv_14d": 3800000,
  "adv_30d": 3000000,
  "buffer_pct": 15.00,
  "high_52w": 0.910,
  "low_52w": 0.720,
  "mtd_pct": 1.20,
  "ytd_pct": 8.45,
  "ret_14w": 4.20,
  "alert_time": "2026-05-10T11:55:00+0000",
  "secret": "YOUR_SECRET_HERE"
}
```

The server validates the `secret` field, rejects unauthenticated requests, and inserts the rest into the `breakouts` table.

## Cost (Render)

- **Web Service (Starter)**: $7/month — needed because free plan sleeps after 15min idle (would miss alerts)
- **Postgres (Free)**: $0 — 1GB storage, 90-day retention, fine for this use case
- **Total**: ~$7/month

If you can tolerate occasional first-alert latency (cold start ~30s) you can use the Free plan for the Web Service too — set `plan: free` in `render.yaml`.

## Caveats

- **Yahoo Finance Kuwait coverage**: most names are present (`.KW` suffix), some illiquid ones may return null prices. Those rows show `—` for live data and fall back to alert-time values.
- **Yahoo is 15-min delayed** — for live execution, your TV terminal is the source of truth. The dashboard is a monitoring/context tool.
- **Render free Postgres caps at 1GB** — at typical alert volume (a few dozen per day for the whole watchlist), 30 days fits in <50MB. Plenty of headroom.
- **TradingView alert limits per tier**: Premium = 400 active alerts. 141 stocks × 1 alert each = 141, well under cap.

## File map

```
kw-breakout/
├── pine_script.pine       # TradingView indicator with webhook
├── render.yaml            # Render blueprint
├── README.md              # this file
├── .env.example
├── .gitignore
├── server/
│   ├── package.json
│   └── index.js           # Express + webhook + Yahoo polling + API
└── client/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx        # Interactive table
        └── index.css      # Institutional dark dashboard styling
```
