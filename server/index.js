import express from "express";
import cors from "cors";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import "dotenv/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

// ============================================================
// CONFIG
// ============================================================
const PORT = process.env.PORT || 10000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "change-me-in-render-env";
const DATABASE_URL = process.env.DATABASE_URL;
const POLL_INTERVAL_MS = 60_000; // refresh live data every 60s
const RETENTION_DAYS = 30;
const YF_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

if (!DATABASE_URL) {
  console.error("FATAL: DATABASE_URL not set");
  process.exit(1);
}

// ============================================================
// POSTGRES
// ============================================================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Render Postgres requires SSL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS breakouts (
      id SERIAL PRIMARY KEY,
      ticker TEXT NOT NULL,
      exchange TEXT NOT NULL DEFAULT 'KSE',
      alert_time TIMESTAMPTZ NOT NULL,
      price_at_alert NUMERIC,
      cum_vol BIGINT,
      threshold BIGINT,
      adv_14d BIGINT,
      adv_30d BIGINT,
      buffer_pct NUMERIC,
      high_52w NUMERIC,
      low_52w NUMERIC,
      mtd_pct NUMERIC,
      ytd_pct NUMERIC,
      ret_14w NUMERIC,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_breakouts_alert_time ON breakouts(alert_time DESC);
    CREATE INDEX IF NOT EXISTS idx_breakouts_ticker ON breakouts(ticker);

    CREATE TABLE IF NOT EXISTS live_quotes (
      ticker TEXT PRIMARY KEY,
      price NUMERIC,
      high_52w NUMERIC,
      low_52w NUMERIC,
      mtd_pct NUMERIC,
      ytd_pct NUMERIC,
      ret_14w NUMERIC,
      day_change_pct NUMERIC,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log("[db] schema ready");
}

// ============================================================
// EXPRESS
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: "text/plain", limit: "1mb" })); // TV may send text/plain

// Webhook endpoint
app.post("/webhook/breakout", async (req, res) => {
  try {
    let payload = req.body;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        return res.status(400).json({ error: "invalid JSON" });
      }
    }

    if (payload.secret !== WEBHOOK_SECRET) {
      console.warn("[webhook] rejected: bad secret from", req.ip);
      return res.status(401).json({ error: "unauthorized" });
    }

    const {
      ticker, exchange = "KSE", price, cum_vol, threshold,
      adv_14d, adv_30d, buffer_pct, high_52w, low_52w,
      mtd_pct, ytd_pct, ret_14w, alert_time,
    } = payload;

    if (!ticker || !alert_time) {
      return res.status(400).json({ error: "missing ticker or alert_time" });
    }

    await pool.query(
      `INSERT INTO breakouts
       (ticker, exchange, alert_time, price_at_alert, cum_vol, threshold,
        adv_14d, adv_30d, buffer_pct, high_52w, low_52w, mtd_pct, ytd_pct, ret_14w)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        ticker, exchange, alert_time, price, cum_vol, threshold,
        adv_14d, adv_30d, buffer_pct, high_52w, low_52w, mtd_pct, ytd_pct, ret_14w,
      ]
    );

    console.log(`[webhook] ${ticker} @ ${alert_time} cumVol=${cum_vol} thr=${threshold}`);

    // Trigger immediate quote refresh
    refreshQuote(ticker).catch(e => console.error("[refresh]", e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error("[webhook] error:", err);
    res.status(500).json({ error: "server error" });
  }
});

// API: synthetic test alert — fires a real webhook to ourselves, end-to-end test
app.post("/api/test-alert", async (req, res) => {
  try {
    const ticker = "TESTALERT";
    const now = new Date();
    const payload = {
      ticker,
      exchange: "KSE",
      price: 1.234,
      cum_vol: 5_500_000,
      threshold: 5_000_000,
      adv_14d: 4_200_000,
      adv_30d: 3_500_000,
      buffer_pct: 15,
      high_52w: 1.500,
      low_52w: 0.800,
      mtd_pct: 2.34,
      ytd_pct: 12.45,
      ret_14w: 5.67,
      alert_time: now.toISOString(),
      secret: WEBHOOK_SECRET,
    };

    const port = PORT;
    const r = await fetch(`http://127.0.0.1:${port}/webhook/breakout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await r.json().catch(() => ({}));

    if (!r.ok) {
      return res.status(r.status).json({ ok: false, step: "internal-webhook", status: r.status, body });
    }
    res.json({ ok: true, message: "test webhook delivered end-to-end", ticker, alert_time: payload.alert_time });
  } catch (err) {
    console.error("[test-alert]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: clear synthetic test rows
app.post("/api/clear-tests", async (req, res) => {
  try {
    const r = await pool.query(`DELETE FROM breakouts WHERE ticker LIKE 'TESTALERT%'`);
    await pool.query(`DELETE FROM live_quotes WHERE ticker LIKE 'TESTALERT%'`);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error("[clear-tests]", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: list breakouts joined with live quotes
app.get("/api/breakouts", async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || RETENTION_DAYS, 90);
    const result = await pool.query(
      `SELECT b.*,
              q.price          AS live_price,
              q.high_52w       AS live_high_52w,
              q.low_52w        AS live_low_52w,
              q.mtd_pct        AS live_mtd_pct,
              q.ytd_pct        AS live_ytd_pct,
              q.ret_14w        AS live_ret_14w,
              q.day_change_pct AS live_day_change_pct,
              q.updated_at     AS quote_updated_at
       FROM breakouts b
       LEFT JOIN live_quotes q ON q.ticker = b.ticker
       WHERE b.alert_time > NOW() - INTERVAL '${days} days'
       ORDER BY b.alert_time DESC`
    );
    res.json({ data: result.rows, count: result.rows.length });
  } catch (err) {
    console.error("[api/breakouts]", err);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true, t: new Date().toISOString() }));

// ============================================================
// YAHOO FINANCE — direct chart endpoint, no library needed
// ============================================================
// Endpoint: https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
// For Kuwait stocks: append .KW suffix (e.g. NBK.KW)
async function fetchYahooChart(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}.KW?interval=1d&range=1y&includePrePost=false`;
  const res = await fetch(url, {
    headers: { "User-Agent": YF_USER_AGENT, "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) {
    const errMsg = json?.chart?.error?.description || "no result";
    throw new Error(errMsg);
  }
  return result;
}

async function refreshQuote(ticker) {
  try {
    const result = await fetchYahooChart(ticker);
    const meta = result.meta || {};
    const timestamps = result.timestamp || [];
    const indicators = result.indicators?.quote?.[0] || {};
    const closes = indicators.close || [];
    const opens  = indicators.open  || [];

    const price       = meta.regularMarketPrice ?? null;
    const hi52        = meta.fiftyTwoWeekHigh ?? null;
    const lo52        = meta.fiftyTwoWeekLow ?? null;
    const prevClose   = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const dayChangePct = price && prevClose ? ((price / prevClose) - 1) * 100 : null;

    let mtdPct = null, ytdPct = null, ret14w = null;

    if (timestamps.length > 0 && closes.length > 0) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
      const yearStart  = new Date(now.getFullYear(), 0, 1).getTime() / 1000;

      // Find first trading bar of current month / year
      const monthIdx = timestamps.findIndex(t => t >= monthStart);
      const yearIdx  = timestamps.findIndex(t => t >= yearStart);

      const monthOpen = monthIdx >= 0 ? opens[monthIdx] ?? closes[monthIdx] : null;
      const yearOpen  = yearIdx  >= 0 ? opens[yearIdx]  ?? closes[yearIdx]  : null;

      if (price && monthOpen) mtdPct = ((price / monthOpen) - 1) * 100;
      if (price && yearOpen)  ytdPct = ((price / yearOpen)  - 1) * 100;

      // 14w (~70 trading days) ago — count back from end of valid closes
      const validIdx = closes.map((c, i) => c != null ? i : -1).filter(i => i >= 0);
      if (validIdx.length > 70 && price) {
        const idx = validIdx[validIdx.length - 70];
        const close14w = closes[idx];
        if (close14w) ret14w = ((price / close14w) - 1) * 100;
      }
    }

    await pool.query(
      `INSERT INTO live_quotes
       (ticker, price, high_52w, low_52w, mtd_pct, ytd_pct, ret_14w, day_change_pct, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (ticker) DO UPDATE SET
         price=$2, high_52w=$3, low_52w=$4, mtd_pct=$5, ytd_pct=$6,
         ret_14w=$7, day_change_pct=$8, updated_at=NOW()`,
      [ticker, price, hi52, lo52, mtdPct, ytdPct, ret14w, dayChangePct]
    );
  } catch (err) {
    console.warn(`[yahoo] ${ticker}: ${err.message}`);
  }
}

async function pollAllActiveTickers() {
  try {
    const r = await pool.query(
      `SELECT DISTINCT ticker FROM breakouts
       WHERE alert_time > NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    if (r.rows.length === 0) return;
    console.log(`[poll] refreshing ${r.rows.length} tickers`);
    for (const row of r.rows) {
      await refreshQuote(row.ticker);
      await new Promise(r => setTimeout(r, 250)); // throttle to avoid rate limits
    }
  } catch (err) {
    console.error("[poll]", err);
  }
}

// ============================================================
// CLEANUP
// ============================================================
async function cleanup() {
  try {
    const r = await pool.query(
      `DELETE FROM breakouts WHERE alert_time < NOW() - INTERVAL '${RETENTION_DAYS} days'`
    );
    if (r.rowCount > 0) console.log(`[cleanup] deleted ${r.rowCount} old breakouts`);
  } catch (err) {
    console.error("[cleanup]", err);
  }
}

// ============================================================
// SERVE STATIC FRONTEND
// ============================================================
const clientDist = path.join(__dirname, "..", "client", "dist");
app.use(express.static(clientDist));
app.get(/^(?!\/api|\/webhook).*/, (req, res) => {
  res.sendFile(path.join(clientDist, "index.html"));
});

// ============================================================
// START
// ============================================================
(async () => {
  await initDb();
  app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));

  pollAllActiveTickers();
  setInterval(pollAllActiveTickers, POLL_INTERVAL_MS);

  cleanup();
  setInterval(cleanup, 24 * 60 * 60 * 1000);
})();
