import React, { useEffect, useState, useMemo, useRef, useCallback } from "react";
import axios from "axios";
import "./App.css";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  LineChart, Line, AreaChart, Area, ScatterChart, Scatter, ZAxis, Cell,
} from "recharts";
import {
  TrendingUp, TrendingDown, Activity, Zap, DollarSign, BarChart3,
  Target, Shield, Newspaper, Globe, RefreshCw, Play, ChevronRight,
  Layers, Cpu, Sparkles, AlertTriangle,
} from "lucide-react";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// -------------------- Helpers --------------------
const fmt = (n, digits = 2) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return (n / 1e12).toFixed(digits) + "T";
  if (abs >= 1e9) return (n / 1e9).toFixed(digits) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(digits) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(digits) + "K";
  return n.toFixed(digits);
};
const fmtNum = (n, d = 2) => (n === null || n === undefined || isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (n, d = 2) => (n === null || n === undefined || isNaN(n) ? "—" : `${(n * 100).toFixed(d)}%`);
const fmtPctRaw = (n, d = 2) => (n === null || n === undefined || isNaN(n) ? "—" : `${n.toFixed(d)}%`);
const cls = (...xs) => xs.filter(Boolean).join(" ");

// -------------------- Reusable widgets --------------------
const Panel = ({ title, right, children, testid, className = "" }) => (
  <div data-testid={testid} className={cls("qe-panel qe-scanline p-4 fadeIn", className)}>
    {(title || right) && (
      <div className="flex items-center justify-between mb-3">
        <div className="qe-overline">{title}</div>
        <div>{right}</div>
      </div>
    )}
    {children}
  </div>
);

const toneClass = (tone) => {
  if (tone === "pos") return "qe-pos";
  if (tone === "neg") return "qe-neg";
  return "qe-cy";
};

const signalClass = (signal) => {
  if (signal === "BUY") return "qe-pos";
  if (signal === "SELL") return "qe-neg";
  return "qe-cy";
};

const KPI = ({ label, value, sub, tone = "cy", testid }) => (
  <div data-testid={testid} className="qe-panel p-4">
    <div className="qe-overline mb-2">{label}</div>
    <div className={cls("qe-num text-2xl font-bold", toneClass(tone))}>{value}</div>
    {sub && <div className="text-xs qe-num text-[var(--text-dim)] mt-1">{sub}</div>}
  </div>
);

const Slider = ({ label, value, onChange, min, max, step, suffix = "%", testid }) => (
  <div className="mb-3">
    <div className="flex justify-between items-baseline mb-1">
      <span className="text-xs text-[var(--text-dim)]">{label}</span>
      <span className="qe-num text-xs qe-cy" data-testid={testid ? testid + "-value" : undefined}>{Number(value).toFixed(step < 1 ? 2 : 1)}{suffix}</span>
    </div>
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(parseFloat(e.target.value))}
      data-testid={testid}
    />
  </div>
);

const NumInput = ({ label, value, onChange, testid, step = "any" }) => (
  <div>
    <div className="qe-overline mb-1">{label}</div>
    <input
      type="number"
      value={value}
      step={step}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className="qe-input"
      data-testid={testid}
    />
  </div>
);

// -------------------- Charts helpers --------------------
const chartAxis = { stroke: "#55697c", fontSize: 10, tickLine: false, axisLine: { stroke: "rgba(0,229,255,0.15)" } };
const tooltipStyle = { backgroundColor: "#0c121a", border: "1px solid rgba(0,229,255,0.4)", borderRadius: 2, fontFamily: "IBM Plex Mono", fontSize: 12 };

// ==================================================
// MAIN APP
// ==================================================
export default function App() {
  const [ticker, setTicker] = useState("TSLA");
  const [tickerInput, setTickerInput] = useState("TSLA");
  const [asset, setAsset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [macro, setMacro] = useState([]);
  const [news, setNews] = useState([]);
  const [peers, setPeers] = useState(null);
  const [tab, setTab] = useState("overview");

  // Assumptions
  const [rf, setRf] = useState(4.25);
  const [erp, setErp] = useState(5.0);
  const [tax, setTax] = useState(21.0);
  const [kd, setKd] = useState(5.5);
  const [g1, setG1] = useState(18.0);
  const [g2, setG2] = useState(4.5);
  const [perp, setPerp] = useState(2.3);
  const [exitMult, setExitMult] = useState(22.0);

  // Overrides
  const [ebitOv, setEbitOv] = useState(0);
  const [capexOv, setCapexOv] = useState(0);
  const [nwcOv, setNwcOv] = useState(0);
  const [ndOv, setNdOv] = useState(0);
  const [daOv, setDaOv] = useState(0);

  // Valuation results
  const [val, setVal] = useState(null);
  const [mc, setMc] = useState(null);
  const [mcRunning, setMcRunning] = useState(false);
  const [sens, setSens] = useState(null);
  const [aiText, setAiText] = useState("");
  const [aiRunning, setAiRunning] = useState(false);

  const loadAsset = useCallback(async (sym) => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.get(`${API}/asset/${sym}`);
      setAsset(data);
      const f = data.financials;
      // Defaults matching the original streamlit special-case for TSLA
      const defaultEbit = sym === "TSLA" ? 12_000_000_000 : f.ebit || 0;
      const defaultCapex = sym === "TSLA" ? 8_000_000_000 : f.capex || 0;
      setEbitOv(defaultEbit);
      setCapexOv(defaultCapex);
      setNwcOv(f.nwc_change || 0);
      setNdOv(f.net_debt || 0);
      setDaOv(f.da || 0);
      // Fire secondary calls in parallel
      const [n, p] = await Promise.all([
        axios.get(`${API}/news/${sym}?limit=8`).then((r) => r.data).catch(() => []),
        axios.get(`${API}/peers/${sym}`).then((r) => r.data).catch(() => null),
      ]);
      setNews(n);
      setPeers(p);
    } catch (e) {
      setError(e?.response?.data?.detail || e.message || "Errore caricamento dati");
      setAsset(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAsset(ticker);
    axios.get(`${API}/macro`).then((r) => setMacro(r.data)).catch((err) => console.warn("macro fetch failed", err));
  }, [ticker, loadAsset]);

  // Recompute valuation whenever assumptions change
  useEffect(() => {
    if (!asset) return;
    const body = {
      ticker: asset.ticker,
      ebit: ebitOv,
      capex: capexOv,
      nwc_change: nwcOv,
      net_debt: ndOv,
      da: daOv,
      rf_rate: rf / 100,
      erp: erp / 100,
      tax_rate: tax / 100,
      cost_of_debt: kd / 100,
      beta: asset.beta,
      g_stage_1: g1 / 100,
      g_stage_2: g2 / 100,
      perp_g: perp / 100,
      exit_multiple: exitMult,
      live_price: asset.live_price,
      shares_outstanding: asset.shares_outstanding,
      peer_pe: peers?.peer_medians?.pe || null,
      peer_ev_ebitda: peers?.peer_medians?.ev_ebitda || null,
      peer_ps: peers?.peer_medians?.ps || null,
      revenue: asset.financials.revenue,
      net_income: asset.financials.net_income,
      dividend_rate: asset.dividend_rate,
    };
    const t = setTimeout(() => {
      axios.post(`${API}/valuation`, body).then((r) => setVal(r.data)).catch(() => {});
      axios.post(`${API}/sensitivity`, body).then((r) => setSens(r.data)).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [asset, ebitOv, capexOv, nwcOv, ndOv, daOv, rf, erp, tax, kd, g1, g2, perp, exitMult, peers]);

  const runMonteCarlo = async () => {
    if (!asset || !val) return;
    setMcRunning(true);
    try {
      const body = {
        ticker: asset.ticker,
        ebit: ebitOv, capex: capexOv, nwc_change: nwcOv, net_debt: ndOv, da: daOv,
        rf_rate: rf / 100, erp: erp / 100, tax_rate: tax / 100, cost_of_debt: kd / 100,
        beta: asset.beta,
        g_stage_1: g1 / 100, g_stage_2: g2 / 100, perp_g: perp / 100, exit_multiple: exitMult,
        live_price: asset.live_price, shares_outstanding: asset.shares_outstanding,
        peer_pe: peers?.peer_medians?.pe || null,
        peer_ev_ebitda: peers?.peer_medians?.ev_ebitda || null,
        peer_ps: peers?.peer_medians?.ps || null,
        revenue: asset.financials.revenue,
        net_income: asset.financials.net_income,
        dividend_rate: asset.dividend_rate,
        n_sims: 2500, growth_vol: 0.035, wacc_vol: 0.012,
      };
      const { data } = await axios.post(`${API}/montecarlo`, body);
      setMc(data);
    } finally {
      setMcRunning(false);
    }
  };

  const runAI = async () => {
    if (!asset || !val) return;
    setAiRunning(true);
    setAiText("");
    try {
      const body = {
        ticker: asset.ticker,
        name: asset.name,
        sector: asset.sector,
        industry: asset.industry,
        signal: val.recommendation.signal,
        market_price: val.recommendation.market_price,
        target_price: val.recommendation.target_price,
        upside_pct: val.recommendation.upside_pct,
        wacc: val.wacc.value,
        implied_g: val.reverse_dcf.implied_g1,
        g_stage_1: g1 / 100, g_stage_2: g2 / 100, perp_g: perp / 100,
        net_debt: ndOv,
        ebit: ebitOv,
        ebitda: val.dcf.ebitda_base,
        revenue: asset.financials.revenue,
        beta: asset.beta,
        prob_undervalued: mc?.prob_undervalued || null,
        var_95: mc?.var_95 || null,
        language: "it",
      };
      const res = await fetch(`${API}/ai/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop() || "";
        for (const p of parts) {
          const line = p.replace(/^data:\s*/, "").trim();
          if (!line) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.delta) setAiText((t) => t + obj.delta);
            if (obj.error) setAiText((t) => t + `\n[Errore AI: ${obj.error}]`);
          } catch (parseErr) {
            console.warn("SSE parse error:", parseErr, "line:", line);
          }
        }
      }
    } catch (e) {
      setAiText("Errore: impossibile generare il report AI. " + (e.message || ""));
    } finally {
      setAiRunning(false);
    }
  };

  const priceDelta = asset ? asset.live_price - asset.previous_close : 0;
  const priceDeltaPct = asset && asset.previous_close ? (priceDelta / asset.previous_close) * 100 : 0;

  return (
    <div className="App min-h-screen">
      {/* HEADER */}
      <header className="border-b border-[var(--border)] bg-[var(--surface)] px-6 py-3 sticky top-0 z-40">
        <div className="flex items-center justify-between gap-6 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 border border-[var(--cyan)] flex items-center justify-center">
              <Activity size={16} className="qe-cy" />
            </div>
            <div>
              <div className="font-mono text-sm font-bold qe-cy tracking-widest">QUANT-EDGE</div>
              <div className="qe-overline text-[9px]">Institutional Terminal · v2.0</div>
            </div>
          </div>

          <form
            onSubmit={(e) => { e.preventDefault(); setTicker(tickerInput.toUpperCase().trim()); }}
            className="flex items-center gap-2"
          >
            <div className="qe-overline">Ticker</div>
            <input
              className="qe-input w-28 uppercase text-center"
              value={tickerInput}
              onChange={(e) => setTickerInput(e.target.value)}
              data-testid="ticker-input"
            />
            <button className="qe-btn" type="submit" data-testid="ticker-search">
              <span className="flex items-center gap-1"><ChevronRight size={14} /> LOAD</span>
            </button>
          </form>

          <div className="flex items-center gap-4 font-mono text-xs">
            <span className="qe-overline flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-[var(--green)] blink" />
              LIVE FEED
            </span>
            <span className="text-[var(--text-dim)]">{new Date().toUTCString().slice(5, 25)} UTC</span>
          </div>
        </div>
      </header>

      {/* MACRO TICKER */}
      {macro.length > 0 && (
        <div className="border-b border-[var(--border)] bg-[var(--bg)] py-2 overflow-hidden">
          <div className="qe-marquee">
            <div className="qe-marquee-track font-mono text-xs">
              {[...macro, ...macro].map((m, i) => (
                <span key={`${m.id}-${i}`} className="mx-6 inline-flex items-center gap-2">
                  <span className="qe-overline text-[9px]">{m.name}</span>
                  <span className="qe-cy">{fmtNum(m.value, 2)}</span>
                  <span className="text-[var(--text-mute)]">·</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MAIN LAYOUT */}
      <div className="max-w-[1600px] mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-4">
        {/* LEFT SIDEBAR — Assumptions */}
        <aside className="lg:col-span-3 space-y-4">
          <Panel title="COST OF CAPITAL / WACC" testid="wacc-panel">
            <NumInput label="Risk-Free Rate 10Y (%)" value={rf} onChange={setRf} testid="rf-input" step="0.05" />
            <div className="h-2" />
            <NumInput label="Equity Risk Premium (%)" value={erp} onChange={setErp} testid="erp-input" step="0.1" />
            <div className="h-2" />
            <NumInput label="Tax Rate (%)" value={tax} onChange={setTax} testid="tax-input" step="0.5" />
            <div className="h-2" />
            <NumInput label="Pre-Tax Cost of Debt (%)" value={kd} onChange={setKd} testid="kd-input" step="0.1" />
          </Panel>

          <Panel title="3-STAGE GROWTH HORIZON" testid="growth-panel">
            <Slider label="Stage 1 (Y1-5) CAGR" value={g1} onChange={setG1} min={-5} max={45} step={0.5} testid="g1" />
            <Slider label="Stage 2 (Y6-10) CAGR" value={g2} onChange={setG2} min={-5} max={25} step={0.5} testid="g2" />
            <Slider label="Perpetual Growth (g)" value={perp} onChange={setPerp} min={0.5} max={4.5} step={0.1} testid="perp" />
            <Slider label="Terminal EV/EBITDA (x)" value={exitMult} onChange={setExitMult} min={5} max={60} step={0.5} suffix="x" testid="exit-mult" />
          </Panel>

          <Panel title="FINANCIAL OVERRIDES" testid="overrides-panel">
            <NumInput label="Normalized EBIT ($)" value={ebitOv} onChange={setEbitOv} testid="ebit-input" />
            <div className="h-2" />
            <NumInput label="CapEx ($)" value={capexOv} onChange={setCapexOv} testid="capex-input" />
            <div className="h-2" />
            <NumInput label="Δ Working Capital ($)" value={nwcOv} onChange={setNwcOv} testid="nwc-input" />
            <div className="h-2" />
            <NumInput label="Net Debt ($)" value={ndOv} onChange={setNdOv} testid="netdebt-input" />
            <div className="h-2" />
            <NumInput label="D&A ($)" value={daOv} onChange={setDaOv} testid="da-input" />
          </Panel>
        </aside>

        {/* MAIN CONTENT */}
        <main className="lg:col-span-9 space-y-4">
          {loading && (
            <div className="qe-panel p-8 text-center font-mono text-[var(--text-dim)]">
              SINCRONIZZAZIONE DATABASE IN CORSO<span className="blink">_</span>
            </div>
          )}
          {error && !loading && (
            <div className="qe-panel p-6 border-[var(--red)] text-[var(--red)] font-mono flex items-center gap-2">
              <AlertTriangle size={18} /> {error}
            </div>
          )}

          {asset && !loading && (
            <>
              {/* Ticker banner */}
              <div className="qe-panel p-5">
                <div className="flex items-start justify-between flex-wrap gap-4">
                  <div>
                    <div className="qe-overline">{asset.exchange} · {asset.sector} · {asset.country}</div>
                    <div className="text-2xl font-bold mt-1 tracking-tight">{asset.name}</div>
                    <div className="qe-num text-sm text-[var(--text-dim)] mt-1">{asset.ticker} · {asset.currency}</div>
                  </div>
                  <div className="text-right">
                    <div className="qe-num text-4xl font-bold">${fmtNum(asset.live_price, 2)}</div>
                    <div className={cls("qe-num text-sm flex items-center justify-end gap-1", priceDelta >= 0 ? "qe-pos" : "qe-neg")}>
                      {priceDelta >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                      {priceDelta >= 0 ? "+" : ""}{fmtNum(priceDelta, 2)} ({priceDeltaPct >= 0 ? "+" : ""}{fmtNum(priceDeltaPct, 2)}%)
                    </div>
                    <div className="qe-num text-[10px] text-[var(--text-dim)] mt-1">
                      52W: {fmtNum(asset.week52_low, 2)} — {fmtNum(asset.week52_high, 2)}
                    </div>
                  </div>
                </div>
              </div>

              {/* KPIs */}
              {val && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <KPI label="WACC" value={fmtPct(val.wacc.value)} sub={`Ke ${fmtPct(val.wacc.cost_of_equity)} · Kd(at) ${fmtPct(val.wacc.after_tax_cost_of_debt)}`} testid="kpi-wacc" />
                  <KPI label="Fair Value (Composite)" value={`$${fmtNum(val.composite.fair_value, 2)}`} tone={val.recommendation.upside_pct >= 0 ? "pos" : "neg"} sub={`${val.recommendation.upside_pct >= 0 ? "+" : ""}${fmtNum(val.recommendation.upside_pct, 2)}% vs mkt`} testid="kpi-fair" />
                  <KPI label="Implied Growth (Reverse DCF)" value={fmtPct(val.reverse_dcf.implied_g1)} sub={`Model g1: ${g1.toFixed(1)}%`} testid="kpi-implied" />
                  <KPI label="Signal" value={val.recommendation.signal} tone={val.recommendation.signal === "BUY" ? "pos" : (val.recommendation.signal === "SELL" ? "neg" : "cy")} sub={`Beta: ${fmtNum(asset.beta, 2)}`} testid="kpi-signal" />
                </div>
              )}

              {/* Tabs */}
              <div className="flex border-b border-[var(--border)] overflow-x-auto">
                {[
                  ["overview", "OVERVIEW", Globe],
                  ["valuation", "VALUATION", Target],
                  ["montecarlo", "MONTE CARLO", Zap],
                  ["peers", "PEERS", Layers],
                  ["report", "AI REPORT", Sparkles],
                  ["news", "NEWS", Newspaper],
                ].map(([k, label, Icon]) => (
                  <button
                    key={k}
                    className={cls("qe-tab flex items-center gap-2", tab === k && "qe-tab-active")}
                    onClick={() => setTab(k)}
                    data-testid={`tab-${k}`}
                  >
                    <Icon size={12} />
                    {label}
                  </button>
                ))}
              </div>

              {/* -------------------- OVERVIEW TAB -------------------- */}
              {tab === "overview" && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Panel title="PRICE 1Y" className="md:col-span-2" testid="chart-price">
                    <div style={{ height: 260 }}>
                      <ResponsiveContainer>
                        <AreaChart data={asset.price_history || []}>
                          <defs>
                            <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#00e5ff" stopOpacity={0.4} />
                              <stop offset="100%" stopColor="#00e5ff" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="rgba(0,229,255,0.08)" vertical={false} />
                          <XAxis dataKey="date" {...chartAxis} minTickGap={80} />
                          <YAxis {...chartAxis} domain={["auto", "auto"]} />
                          <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: "#8a99a8" }} />
                          <Area type="monotone" dataKey="close" stroke="#00e5ff" strokeWidth={1.5} fill="url(#pg)" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </Panel>

                  <Panel title="PROFILE" testid="profile-panel">
                    <table className="w-full text-xs qe-num">
                      <tbody>
                        {[
                          ["Market Cap", `$${fmt(asset.live_price * asset.shares_outstanding)}`],
                          ["Shares Out", fmt(asset.shares_outstanding, 2)],
                          ["Beta", fmtNum(asset.beta, 2)],
                          ["Trailing P/E", fmtNum(asset.trailing_pe, 2)],
                          ["Forward P/E", fmtNum(asset.forward_pe, 2)],
                          ["EV/EBITDA", fmtNum(asset.ev_ebitda, 2)],
                          ["P/S", fmtNum(asset.price_to_sales, 2)],
                          ["P/B", fmtNum(asset.price_to_book, 2)],
                          ["Div Yield", fmtPct(asset.dividend_yield)],
                          ["ROE", fmtPct(asset.roe)],
                          ["Profit Margin", fmtPct(asset.profit_margin)],
                          ["Employees", fmt(asset.employees, 0)],
                          ["Analyst Rec", (asset.recommendation || "N/A").toUpperCase()],
                          ["Consensus PT", asset.target_mean ? `$${fmtNum(asset.target_mean, 2)}` : "—"],
                        ].map(([k, v]) => (
                          <tr key={k} className="border-b border-[var(--border)]">
                            <td className="py-1.5 qe-overline text-[10px]">{k}</td>
                            <td className="py-1.5 text-right qe-cy">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>

                  <Panel title="BUSINESS DESCRIPTION" className="md:col-span-3" testid="business-panel">
                    <p className="text-sm text-[var(--text-dim)] leading-relaxed">{asset.summary}</p>
                    {asset.website && (
                      <a href={asset.website} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs qe-cy hover:underline font-mono">
                        <Globe size={12} /> {asset.website}
                      </a>
                    )}
                  </Panel>

                  <Panel title="ESG · SUPPLY CHAIN RISK MATRIX" className="md:col-span-3" testid="esg-panel">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div className="border-l-2 border-[var(--green)] pl-3">
                        <div className="qe-overline mb-1">Strengths (E&S)</div>
                        <p className="text-xs text-[var(--text-dim)] leading-relaxed">Spinta strutturale verso la decarbonizzazione operativa, energia rinnovabile nei siti core e piani azionari sostenibili per il top management.</p>
                      </div>
                      <div className="border-l-2 border-[var(--red)] pl-3">
                        <div className="qe-overline mb-1">Weaknesses (Governance)</div>
                        <p className="text-xs text-[var(--text-dim)] leading-relaxed">Diritti di voto asimmetrici per soci fondatori, gender pay gap ancora oltre le medie di settore.</p>
                      </div>
                      <div className="border-l-2 border-[var(--green)] pl-3">
                        <div className="qe-overline mb-1">Strengths (Supply Chain)</div>
                        <p className="text-xs text-[var(--text-dim)] leading-relaxed">Integrazione verticale su componenti critici e contratti di business continuity a lungo termine.</p>
                      </div>
                      <div className="border-l-2 border-[var(--red)] pl-3">
                        <div className="qe-overline mb-1">Weaknesses (Friction)</div>
                        <p className="text-xs text-[var(--text-dim)] leading-relaxed">Dipendenza geografica da fonderie asiatiche, esposizione alla volatilità di silicio, rame e leghe industriali.</p>
                      </div>
                    </div>
                  </Panel>
                </div>
              )}

              {/* -------------------- VALUATION TAB -------------------- */}
              {tab === "valuation" && val && (
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <Panel title="10-YEAR PROJECTED FCFF" className="md:col-span-2" testid="chart-fcff">
                    <div style={{ height: 260 }}>
                      <ResponsiveContainer>
                        <BarChart data={val.dcf.flows.map((v, i) => ({ year: `Y${i + 1}`, fcff: v, pv: val.dcf.discounted[i] }))}>
                          <CartesianGrid stroke="rgba(0,229,255,0.08)" vertical={false} />
                          <XAxis dataKey="year" {...chartAxis} />
                          <YAxis {...chartAxis} tickFormatter={(v) => "$" + fmt(v, 1)} />
                          <Tooltip contentStyle={tooltipStyle} formatter={(v) => "$" + fmt(v, 2)} />
                          <Bar dataKey="fcff" fill="#00e5ff" opacity={0.6} name="FCFF" />
                          <Bar dataKey="pv" fill="#00ff66" name="Present Value" />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </Panel>

                  <Panel title="CAPITAL STRUCTURE" testid="capstruct-panel">
                    <div className="space-y-3 mt-2">
                      <div>
                        <div className="flex justify-between text-xs qe-num">
                          <span className="text-[var(--text-dim)]">Equity</span>
                          <span className="qe-cy">{fmtPct(val.wacc.weight_equity)}</span>
                        </div>
                        <div className="h-2 bg-[var(--surface-2)] mt-1">
                          <div className="h-full bg-[var(--cyan)]" style={{ width: `${val.wacc.weight_equity * 100}%` }} />
                        </div>
                        <div className="qe-num text-xs text-[var(--text-dim)] mt-1">${fmt(val.wacc.market_cap)}</div>
                      </div>
                      <div>
                        <div className="flex justify-between text-xs qe-num">
                          <span className="text-[var(--text-dim)]">Debt</span>
                          <span className="qe-cy">{fmtPct(val.wacc.weight_debt)}</span>
                        </div>
                        <div className="h-2 bg-[var(--surface-2)] mt-1">
                          <div className="h-full bg-[var(--amber)]" style={{ width: `${val.wacc.weight_debt * 100}%` }} />
                        </div>
                        <div className="qe-num text-xs text-[var(--text-dim)] mt-1">${fmt(Math.max(0, ndOv))}</div>
                      </div>
                      <div className="qe-divider pt-3">
                        <div className="qe-overline mb-1">FCFF Base</div>
                        <div className="qe-num qe-cy text-lg">${fmt(val.dcf.fcff_base, 2)}</div>
                      </div>
                      <div>
                        <div className="qe-overline mb-1">EBITDA Base</div>
                        <div className="qe-num qe-cy text-lg">${fmt(val.dcf.ebitda_base, 2)}</div>
                      </div>
                    </div>
                  </Panel>

                  <Panel title="VALUATION MODELS COMPARISON" className="md:col-span-3" testid="valcompare">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          <th className="text-left qe-overline py-2">Model</th>
                          <th className="text-right qe-overline py-2">Target Price</th>
                          <th className="text-right qe-overline py-2">Upside</th>
                          <th className="text-right qe-overline py-2">Weight</th>
                        </tr>
                      </thead>
                      <tbody>
                        {val.composite.components.map((c) => {
                          const up = ((c.value - asset.live_price) / asset.live_price) * 100;
                          return (
                            <tr key={c.name} className="border-b border-[var(--border)]">
                              <td className="py-2 font-mono text-xs">{c.name}</td>
                              <td className="py-2 text-right qe-num qe-cy">${fmtNum(c.value, 2)}</td>
                              <td className={cls("py-2 text-right qe-num", up >= 0 ? "qe-pos" : "qe-neg")}>{up >= 0 ? "+" : ""}{fmtNum(up, 2)}%</td>
                              <td className="py-2 text-right qe-num">{fmtPct(c.weight, 1)}</td>
                            </tr>
                          );
                        })}
                        <tr className="border-t-2 border-[var(--cyan)]">
                          <td className="py-2 font-mono font-bold qe-cy">COMPOSITE FAIR VALUE</td>
                          <td className="py-2 text-right qe-num qe-cy text-lg font-bold">${fmtNum(val.composite.fair_value, 2)}</td>
                          <td className={cls("py-2 text-right qe-num font-bold", val.recommendation.upside_pct >= 0 ? "qe-pos" : "qe-neg")}>
                            {val.recommendation.upside_pct >= 0 ? "+" : ""}{fmtNum(val.recommendation.upside_pct, 2)}%
                          </td>
                          <td className="py-2 text-right qe-num">100%</td>
                        </tr>
                      </tbody>
                    </table>
                  </Panel>

                  {sens && sens.matrix && (
                    <Panel title="SENSITIVITY HEATMAP · WACC × GROWTH" className="md:col-span-3" testid="sens-heatmap">
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs qe-num border-collapse">
                          <thead>
                            <tr>
                              <th className="qe-overline text-left p-1">WACC / g1</th>
                              {sens.growth_axis.map((g) => (
                                <th key={`h-g-${g}`} className="qe-overline p-1 text-right">{(g * 100).toFixed(1)}%</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {sens.matrix.map((row, ri) => (
                              <tr key={`row-${sens.wacc_axis[ri]}`}>
                                <td className="qe-overline p-1 text-right border-r border-[var(--border)]">{(sens.wacc_axis[ri] * 100).toFixed(2)}%</td>
                                {row.map((v, ci) => {
                                  const cellKey = `c-${ri}-${sens.growth_axis[ci]}`;
                                  if (v === null) return <td key={cellKey} className="p-1 text-center text-[var(--text-mute)]">—</td>;
                                  const up = (v - asset.live_price) / asset.live_price;
                                  const intensity = Math.min(1, Math.abs(up));
                                  const bg = up >= 0
                                    ? `rgba(0,255,102,${0.1 + intensity * 0.5})`
                                    : `rgba(255,51,102,${0.1 + intensity * 0.5})`;
                                  return (
                                    <td key={cellKey} className="p-1 text-right border border-[var(--border)]" style={{ backgroundColor: bg }}>
                                      ${fmtNum(v, 0)}
                                    </td>
                                  );
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="qe-overline mt-2">Market Price: <span className="qe-cy">${fmtNum(asset.live_price, 2)}</span> — cell shows target price / cell color = upside vs market</div>
                    </Panel>
                  )}
                </div>
              )}

              {/* -------------------- MONTE CARLO TAB -------------------- */}
              {tab === "montecarlo" && (
                <div className="space-y-4">
                  <Panel title="MONTE CARLO RISK ENGINE" testid="mc-panel">
                    <p className="text-sm text-[var(--text-dim)] mb-3">
                      Esegue <span className="qe-cy qe-num">2.500 simulazioni stocastiche</span> variando congiuntamente WACC e Growth con distribuzioni normali, calcolando la probabilità che il fair value ecceda il prezzo di mercato oltre a VaR/CVaR a 95%.
                    </p>
                    <button className="qe-btn qe-btn-primary" onClick={runMonteCarlo} disabled={mcRunning || !val} data-testid="mc-run">
                      {mcRunning ? "SIMULAZIONE IN CORSO…" : <span className="flex items-center gap-1"><Play size={12} /> ESEGUI SIMULAZIONE</span>}
                    </button>
                  </Panel>

                  {mc && !mc.error && (
                    <>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <KPI label="Prob. Undervaluation" value={`${fmtNum(mc.prob_undervalued, 1)}%`} tone={mc.prob_undervalued > 50 ? "pos" : "neg"} testid="mc-prob" />
                        <KPI label="Median Target" value={`$${fmtNum(mc.median, 2)}`} sub={`σ ${fmtNum(mc.std, 2)}`} testid="mc-median" />
                        <KPI label="VaR 95%" value={fmtPctRaw(mc.var_95 * 100, 2)} tone="neg" sub="1-tail loss" testid="mc-var" />
                        <KPI label="CVaR 95%" value={fmtPctRaw(mc.cvar_95 * 100, 2)} tone="neg" sub="Expected shortfall" testid="mc-cvar" />
                      </div>

                      <Panel title="TARGET PRICE DISTRIBUTION" testid="mc-hist">
                        <div style={{ height: 300 }}>
                          <ResponsiveContainer>
                            <BarChart data={mc.histogram}>
                              <CartesianGrid stroke="rgba(0,229,255,0.08)" vertical={false} />
                              <XAxis dataKey="x" {...chartAxis} tickFormatter={(v) => "$" + fmtNum(v, 0)} />
                              <YAxis {...chartAxis} />
                              <Tooltip contentStyle={tooltipStyle} formatter={(v) => v} labelFormatter={(v) => "$" + fmtNum(v, 2)} />
                              <Bar dataKey="y" fill="#00ff66" />
                            </BarChart>
                          </ResponsiveContainer>
                        </div>
                        <div className="mt-3 text-xs qe-num text-[var(--text-dim)] flex flex-wrap gap-4">
                          <span>Mkt Price: <span className="qe-cy">${fmtNum(mc.market_price, 2)}</span></span>
                          <span>P5: <span className="qe-cy">${fmtNum(mc.p5, 2)}</span></span>
                          <span>P25: <span className="qe-cy">${fmtNum(mc.p25, 2)}</span></span>
                          <span>P75: <span className="qe-cy">${fmtNum(mc.p75, 2)}</span></span>
                          <span>P95: <span className="qe-cy">${fmtNum(mc.p95, 2)}</span></span>
                          <span>N: <span className="qe-cy">{mc.n_valid}</span></span>
                        </div>
                      </Panel>
                    </>
                  )}
                </div>
              )}

              {/* -------------------- PEERS TAB -------------------- */}
              {tab === "peers" && peers && (
                <Panel title="PEER GROUP BENCHMARKING" testid="peers-panel">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs qe-num">
                      <thead>
                        <tr className="border-b border-[var(--border)]">
                          <th className="text-left qe-overline py-2">Ticker</th>
                          <th className="text-left qe-overline py-2">Name</th>
                          <th className="text-right qe-overline py-2">Price</th>
                          <th className="text-right qe-overline py-2">Mkt Cap</th>
                          <th className="text-right qe-overline py-2">P/E</th>
                          <th className="text-right qe-overline py-2">Fwd P/E</th>
                          <th className="text-right qe-overline py-2">EV/EBITDA</th>
                          <th className="text-right qe-overline py-2">P/S</th>
                          <th className="text-right qe-overline py-2">Margin</th>
                          <th className="text-right qe-overline py-2">Rev Growth</th>
                          <th className="text-right qe-overline py-2">ROE</th>
                          <th className="text-right qe-overline py-2">β</th>
                        </tr>
                      </thead>
                      <tbody>
                        {peers.rows.map((r) => (
                          <tr key={r.ticker} className={cls("border-b border-[var(--border)]", r.is_target && "bg-[var(--surface-2)]")}>
                            <td className={cls("py-2 font-bold", r.is_target && "qe-cy")}>{r.ticker}{r.is_target && " ★"}</td>
                            <td className="py-2 text-[var(--text-dim)] truncate max-w-[140px]">{r.name}</td>
                            <td className="py-2 text-right">${fmtNum(r.price, 2)}</td>
                            <td className="py-2 text-right">${fmt(r.market_cap)}</td>
                            <td className="py-2 text-right">{fmtNum(r.pe, 1)}</td>
                            <td className="py-2 text-right">{fmtNum(r.forward_pe, 1)}</td>
                            <td className="py-2 text-right">{fmtNum(r.ev_ebitda, 1)}</td>
                            <td className="py-2 text-right">{fmtNum(r.ps, 1)}</td>
                            <td className={cls("py-2 text-right", r.profit_margin >= 0 ? "qe-pos" : "qe-neg")}>{fmtPct(r.profit_margin, 1)}</td>
                            <td className={cls("py-2 text-right", r.revenue_growth >= 0 ? "qe-pos" : "qe-neg")}>{fmtPct(r.revenue_growth, 1)}</td>
                            <td className="py-2 text-right">{fmtPct(r.roe, 1)}</td>
                            <td className="py-2 text-right">{fmtNum(r.beta, 2)}</td>
                          </tr>
                        ))}
                        <tr className="border-t-2 border-[var(--cyan)] font-bold">
                          <td className="py-2 qe-cy" colSpan={2}>PEER MEDIAN</td>
                          <td className="py-2 text-right" colSpan={2}>—</td>
                          <td className="py-2 text-right qe-cy">{fmtNum(peers.peer_medians?.pe, 1)}</td>
                          <td className="py-2 text-right qe-cy">{fmtNum(peers.peer_medians?.forward_pe, 1)}</td>
                          <td className="py-2 text-right qe-cy">{fmtNum(peers.peer_medians?.ev_ebitda, 1)}</td>
                          <td className="py-2 text-right qe-cy">{fmtNum(peers.peer_medians?.ps, 1)}</td>
                          <td className="py-2 text-right qe-cy">{fmtPct(peers.peer_medians?.profit_margin, 1)}</td>
                          <td className="py-2 text-right qe-cy">{fmtPct(peers.peer_medians?.revenue_growth, 1)}</td>
                          <td className="py-2 text-right">—</td>
                          <td className="py-2 text-right">—</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                  <div className="qe-overline mt-3">Peer medians used for multiple-based valuation in composite fair value.</div>
                </Panel>
              )}

              {/* -------------------- REPORT TAB -------------------- */}
              {tab === "report" && val && (
                <div className="space-y-4">
                  <Panel title="AI-GENERATED EQUITY RESEARCH · CLAUDE SONNET 4.6" testid="ai-panel">
                    <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                      <p className="text-xs text-[var(--text-dim)] max-w-2xl">
                        Genera un report d&apos;iniziazione di copertura in stile buy-side, con tesi d&apos;investimento, assumptions DCF, risk factors e conclusione a 12 mesi. Powered by Emergent Universal Key (free).
                      </p>
                      <button className="qe-btn qe-btn-primary" onClick={runAI} disabled={aiRunning || !val} data-testid="ai-run">
                        {aiRunning ? <span className="flex items-center gap-1"><Cpu size={12} className="animate-spin" /> GENERATING…</span> : <span className="flex items-center gap-1"><Sparkles size={12} /> GENERATE REPORT</span>}
                      </button>
                    </div>

                    <div className="qe-panel p-6 border-l-2 border-[var(--cyan)] bg-[var(--bg)]">
                      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                        <div>
                          <div className="qe-overline">QUANT-EDGE Equity Research · Initiation of Coverage</div>
                          <div className="text-xl font-bold mt-1">{asset.name} <span className="qe-cy">({asset.ticker})</span></div>
                        </div>
                        <div className="text-right">
                          <div className={cls("qe-num text-3xl font-bold", signalClass(val.recommendation.signal))}>
                            {val.recommendation.signal}
                          </div>
                          <div className="qe-num text-sm qe-cy">PT ${fmtNum(val.composite.fair_value, 2)}</div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-xs qe-num border-t border-b border-[var(--border)] py-3">
                        <div><div className="qe-overline">Market</div><div>${fmtNum(asset.live_price, 2)}</div></div>
                        <div><div className="qe-overline">Target</div><div className="qe-cy">${fmtNum(val.composite.fair_value, 2)}</div></div>
                        <div><div className="qe-overline">Upside</div><div className={val.recommendation.upside_pct >= 0 ? "qe-pos" : "qe-neg"}>{val.recommendation.upside_pct >= 0 ? "+" : ""}{fmtNum(val.recommendation.upside_pct, 2)}%</div></div>
                        <div><div className="qe-overline">WACC</div><div>{fmtPct(val.wacc.value)}</div></div>
                        <div><div className="qe-overline">Implied g</div><div>{fmtPct(val.reverse_dcf.implied_g1)}</div></div>
                      </div>
                      {aiText ? (
                        <div className="text-sm leading-relaxed whitespace-pre-wrap text-[var(--text)]" data-testid="ai-content">
                          {aiText}
                          {aiRunning && <span className="blink">▊</span>}
                        </div>
                      ) : (
                        <div className="text-sm text-[var(--text-dim)] italic">Clicca &quot;GENERATE REPORT&quot; per produrre la tesi d&apos;investimento AI in tempo reale.</div>
                      )}
                      {!aiRunning && aiText && (
                        <div className="mt-4 pt-3 border-t border-[var(--border)] qe-overline text-right">— QUANT-EDGE Institutional Desk</div>
                      )}
                    </div>
                  </Panel>

                  <Panel title="MODEL ASSUMPTIONS SNAPSHOT" testid="assumptions-snapshot">
                    <table className="w-full text-xs qe-num">
                      <tbody>
                        {[
                          ["Normalized EBIT", `$${fmt(ebitOv)}`],
                          ["Weighted Avg. Cost of Capital", fmtPct(val.wacc.value)],
                          ["Total Net Debt", `$${fmt(ndOv)}`],
                          ["Terminal EV/EBITDA", `${fmtNum(exitMult, 1)}x`],
                          ["Stage 1 CAGR (Y1-5)", `${fmtNum(g1, 1)}%`],
                          ["Stage 2 CAGR (Y6-10)", `${fmtNum(g2, 1)}%`],
                          ["Perpetual g", `${fmtNum(perp, 2)}%`],
                          ["Beta", fmtNum(asset.beta, 2)],
                          ["Risk-Free Rate", `${fmtNum(rf, 2)}%`],
                          ["Equity Risk Premium", `${fmtNum(erp, 2)}%`],
                        ].map(([k, v]) => (
                          <tr key={k} className="border-b border-[var(--border)]">
                            <td className="py-2 qe-overline text-[10px]">{k}</td>
                            <td className="py-2 text-right qe-cy">{v}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Panel>
                </div>
              )}

              {/* -------------------- NEWS TAB -------------------- */}
              {tab === "news" && (
                <Panel title="LIVE MARKET SURVEILLANCE" testid="news-panel">
                  {news.length === 0 ? (
                    <div className="text-sm text-[var(--text-dim)] py-4">Nessuna notizia rilevata sul circuito internazionale.</div>
                  ) : (
                    <ul className="space-y-3">
                      {news.map((n, i) => (
                        <li key={n.link || `news-${i}`} className="border-l-2 border-[var(--cyan)] pl-3 py-1 hover:bg-[var(--surface-2)] transition-colors">
                          <a href={n.link} target="_blank" rel="noreferrer" className="block">
                            <div className="text-sm font-medium hover:qe-cy" data-testid={`news-item-${i}`}>{n.title}</div>
                            <div className="qe-overline mt-1 flex gap-3">
                              <span>{n.publisher}</span>
                              {n.published && <span className="text-[var(--text-mute)]">{n.published}</span>}
                            </div>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              )}
            </>
          )}
        </main>
      </div>

      <footer className="border-t border-[var(--border)] mt-8 py-4 text-center qe-overline">
        QUANT-EDGE Institutional Terminal · Free Data Sources: Yahoo Finance · FRED · Google News · Powered by Emergent LLM Key
      </footer>
    </div>
  );
}
