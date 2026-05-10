import { useEffect, useMemo, useState, useCallback } from "react";

const FETCH_URL = "/api/breakouts";
const REFRESH_MS = 30_000;

// ---- formatting helpers ----
const fmtNum = (v, decimals = 3) =>
  v == null || isNaN(v) ? "—" : Number(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtPct = (v) =>
  v == null || isNaN(v) ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(2)}%`;

const fmtBigInt = (v) =>
  v == null ? "—" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 });

const fmtTime = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-GB", { timeZone: "Asia/Kuwait", hour12: false });
};

const sinceNow = (iso) => {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const tvLink = (ticker) => `https://www.tradingview.com/chart/?symbol=KSE%3A${ticker}`;

// ---- buffer tier classifier ----
// Maps numeric buffer_pct to one of three tiers, tolerating slight variations
const bufferTier = (b) => {
  if (b == null) return "unknown";
  const n = Number(b);
  if (n < 75) return "50";   // anything <75% bucketed as the "50%" tier
  return "100";              // 75%+ as the "100%" tier
};

// ---- columns ----
const COLUMNS = [
  { key: "alert_time",          label: "Alert Time", align: "left",  sortable: true,  type: "date"   },
  { key: "ticker",              label: "Ticker",     align: "left",  sortable: true,  type: "string" },
  { key: "buffer_pct",          label: "Buffer",     align: "right", sortable: true,  type: "pct_raw" },
  { key: "live_price",          label: "Price",      align: "right", sortable: true,  type: "num"    },
  { key: "live_day_change_pct", label: "Day %",      align: "right", sortable: true,  type: "pct"    },
  { key: "live_high_52w",       label: "52W High",   align: "right", sortable: true,  type: "num"    },
  { key: "live_low_52w",        label: "52W Low",    align: "right", sortable: true,  type: "num"    },
  { key: "live_mtd_pct",        label: "MTD",        align: "right", sortable: true,  type: "pct"    },
  { key: "live_ytd_pct",        label: "YTD",        align: "right", sortable: true,  type: "pct"    },
  { key: "live_ret_14w",        label: "14W",        align: "right", sortable: true,  type: "pct"    },
  { key: "cum_vol",             label: "Cum Vol",    align: "right", sortable: true,  type: "int"    },
  { key: "threshold",           label: "Threshold",  align: "right", sortable: true,  type: "int"    },
];

// ---- theme management ----
const THEME_KEY = "kwbreakout-theme";
function getInitialTheme() {
  // 1) Explicit user choice in localStorage wins
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(THEME_KEY) : null;
  if (saved === "light" || saved === "dark") return saved;
  // 2) Fall back to system preference
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "dark";
}

export default function App() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [lastFetch, setLastFetch] = useState(null);
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState("alert_time");
  const [sortDir, setSortDir] = useState("desc");
  const [dayFilter, setDayFilter] = useState("today");
  const [bufferTab, setBufferTab] = useState("all"); // "all" | "50" | "100"
  const [theme, setTheme] = useState(getInitialTheme);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [userPickedTheme, setUserPickedTheme] = useState(
    typeof localStorage !== "undefined" && !!localStorage.getItem(THEME_KEY)
  );

  // ---- apply theme to <html> ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // ---- listen to system preference changes (only if user hasn't picked) ----
  useEffect(() => {
    if (userPickedTheme) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e) => setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [userPickedTheme]);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setUserPickedTheme(true);
    localStorage.setItem(THEME_KEY, next);
  };

  // ---- data fetch ----
  const fetchData = useCallback(async () => {
    try {
      const r = await fetch(FETCH_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = await r.json();
      setRows(json.data || []);
      setLastFetch(new Date());
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const showToast = (kind, message) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 4000);
  };

  const sendTestAlert = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/test-alert", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        showToast("ok", "Test webhook delivered. Refreshing…");
        await fetchData();
      } else {
        showToast("err", `Test failed: ${j.error || j.step || "unknown"}`);
      }
    } catch (e) {
      showToast("err", `Test failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const clearTests = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/clear-tests", { method: "POST" });
      const j = await r.json();
      if (j.ok) {
        showToast("ok", `Cleared ${j.deleted} test row${j.deleted === 1 ? "" : "s"}.`);
        await fetchData();
      } else {
        showToast("err", `Clear failed: ${j.error || "unknown"}`);
      }
    } catch (e) {
      showToast("err", `Clear failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  // ---- counts per buffer tab (for badge counts) ----
  const bufferCounts = useMemo(() => {
    const c = { all: rows.length, "50": 0, "100": 0 };
    for (const r of rows) {
      const t = bufferTier(r.buffer_pct);
      if (t === "50" || t === "100") c[t]++;
    }
    return c;
  }, [rows]);

  // ---- filter + sort ----
  const filtered = useMemo(() => {
    let r = rows;

    // Buffer tab filter
    if (bufferTab !== "all") {
      r = r.filter(x => bufferTier(x.buffer_pct) === bufferTab);
    }

    // Day filter
    const now = Date.now();
    if (dayFilter === "today") {
      const d0 = new Date(); d0.setHours(0,0,0,0);
      r = r.filter(x => new Date(x.alert_time) >= d0);
    } else if (dayFilter === "7d") {
      r = r.filter(x => now - new Date(x.alert_time).getTime() < 7 * 86400 * 1000);
    }

    // Search filter
    if (search) {
      const q = search.toUpperCase();
      r = r.filter(x => x.ticker.toUpperCase().includes(q));
    }

    // Sort
    const col = COLUMNS.find(c => c.key === sortKey);
    const type = col?.type;
    const dir = sortDir === "asc" ? 1 : -1;
    r = [...r].sort((a, b) => {
      let av = a[sortKey], bv = b[sortKey];
      if (type === "date") { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
      else if (type === "string") { av = (av||"").toString(); bv = (bv||"").toString(); return av.localeCompare(bv) * dir; }
      else { av = av == null ? -Infinity : Number(av); bv = bv == null ? -Infinity : Number(bv); }
      if (av < bv) return -1 * dir;
      if (av > bv) return  1 * dir;
      return 0;
    });

    return r;
  }, [rows, search, sortKey, sortDir, dayFilter, bufferTab]);

  const onSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("desc"); }
  };

  return (
    <div className="app">
      <header className="hdr">
        <div className="hdr-top">
          <div className="brand">
            <span className="brand-mark">◈</span>
            <div className="brand-text">
              <h1>Boursa Kuwait <span>Volume Breakouts</span></h1>
              <p>Live monitor — cumulative session volume crossing max(14d, 30d) ADV + buffer</p>
            </div>
          </div>

          <div className="hdr-right">
            <div className="status">
              <span className={`pulse ${err ? "err" : "ok"}`}></span>
              <span className="status-text">
                {err ? `connection error: ${err}` : lastFetch ? `last sync ${sinceNow(lastFetch.toISOString())}` : "loading…"}
              </span>
            </div>
            <button
              className="theme-btn"
              onClick={toggleTheme}
              title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              aria-label="Toggle theme"
            >
              {theme === "dark" ? <SunIcon /> : <MoonIcon />}
            </button>
          </div>
        </div>

        {/* Buffer tier tabs — primary navigation */}
        <div className="tab-strip">
          {[
            { v: "all", label: "All Breakouts",   sub: "Combined" },
            { v: "50",  label: "50% Buffer",      sub: "Standard signal" },
            { v: "100", label: "100% Buffer",     sub: "Extreme signal" },
          ].map(t => (
            <button
              key={t.v}
              className={`tab ${bufferTab === t.v ? "active" : ""}`}
              onClick={() => setBufferTab(t.v)}
            >
              <span className="tab-label">{t.label}</span>
              <span className="tab-sub">{t.sub}</span>
              <span className="tab-count">{bufferCounts[t.v]}</span>
            </button>
          ))}
        </div>

        <div className="hdr-controls">
          <div className="filter-group">
            {[
              { v: "today", label: "Today" },
              { v: "7d",    label: "7 Days" },
              { v: "30d",   label: "30 Days" },
            ].map(o => (
              <button
                key={o.v}
                className={`chip ${dayFilter === o.v ? "active" : ""}`}
                onClick={() => setDayFilter(o.v)}
              >
                {o.label}
              </button>
            ))}
          </div>

          <input
            className="search"
            type="search"
            placeholder="Filter by ticker…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <div className="action-group">
            <button
              className="action-btn"
              onClick={sendTestAlert}
              disabled={busy}
              title="Fires a synthetic webhook end-to-end through your secret + DB + UI to verify the pipeline."
            >
              <span className="action-dot"></span>
              {busy ? "Sending…" : "Test Alert"}
            </button>
            <button
              className="action-btn ghost"
              onClick={clearTests}
              disabled={busy}
              title="Removes all rows where ticker = TESTALERT."
            >
              Clear Tests
            </button>
          </div>

          <div className="meta">
            <span className="meta-num">{filtered.length}</span>
            <span className="meta-lbl">events</span>
          </div>
        </div>
      </header>

      <main className="main">
        {loading ? (
          <div className="state">Loading breakout data…</div>
        ) : filtered.length === 0 ? (
          <div className="state">
            <div className="state-title">No breakouts in this window</div>
            <div className="state-sub">
              Webhook events from TradingView will appear here in real time.
              {dayFilter === "today" ? " Try expanding to 7 or 30 days." : ""}
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {COLUMNS.map(c => (
                    <th
                      key={c.key}
                      className={`th-${c.align} ${c.sortable ? "sortable" : ""}`}
                      onClick={() => c.sortable && onSort(c.key)}
                    >
                      <span className="th-label">{c.label}</span>
                      {sortKey === c.key && (
                        <span className="sort-ind">{sortDir === "asc" ? "↑" : "↓"}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, idx) => {
                  const tier = bufferTier(r.buffer_pct);
                  return (
                    <tr key={r.id || idx} className={`row-tier-${tier}`}>
                      <td className="td-left mono dim">
                        <div className="cell-stack">
                          <span>{fmtTime(r.alert_time)}</span>
                          <span className="sub">{sinceNow(r.alert_time)}</span>
                        </div>
                      </td>
                      <td className="td-left">
                        <a className="ticker-link" href={tvLink(r.ticker)} target="_blank" rel="noopener noreferrer">
                          {r.ticker}
                        </a>
                      </td>
                      <td className="td-right">
                        <span className={`buffer-pill tier-${tier}`}>
                          {r.buffer_pct ? `+${Number(r.buffer_pct).toFixed(0)}%` : "—"}
                        </span>
                      </td>
                      <td className="td-right mono">{fmtNum(r.live_price ?? r.price_at_alert)}</td>
                      <td className={`td-right mono ${pctClass(r.live_day_change_pct)}`}>
                        {fmtPct(r.live_day_change_pct)}
                      </td>
                      <td className="td-right mono">{fmtNum(r.live_high_52w ?? r.high_52w)}</td>
                      <td className="td-right mono">{fmtNum(r.live_low_52w ?? r.low_52w)}</td>
                      <td className={`td-right mono ${pctClass(r.live_mtd_pct ?? r.mtd_pct)}`}>
                        {fmtPct(r.live_mtd_pct ?? r.mtd_pct)}
                      </td>
                      <td className={`td-right mono ${pctClass(r.live_ytd_pct ?? r.ytd_pct)}`}>
                        {fmtPct(r.live_ytd_pct ?? r.ytd_pct)}
                      </td>
                      <td className={`td-right mono ${pctClass(r.live_ret_14w ?? r.ret_14w)}`}>
                        {fmtPct(r.live_ret_14w ?? r.ret_14w)}
                      </td>
                      <td className="td-right mono">{fmtBigInt(r.cum_vol)}</td>
                      <td className="td-right mono dim">{fmtBigInt(r.threshold)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>

      <footer className="ftr">
        <span>Auto-refresh every 30s · Live quotes via Yahoo Finance (15-min delayed)</span>
        <span>Data retention: 30 days · Built for Coast IR/PM workflow</span>
      </footer>

      {toast && (
        <div className={`toast toast-${toast.kind}`}>
          <span className="toast-dot"></span>
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}

function pctClass(v) {
  if (v == null || isNaN(v)) return "";
  if (Number(v) > 0) return "pos";
  if (Number(v) < 0) return "neg";
  return "";
}

// ---- icons (inline SVG, no dependency) ----
function SunIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
