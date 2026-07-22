"""
QUANT-EDGE Institutional Investment Terminal — Backend
Bloomberg-style buy-side valuation engine.
"""
from fastapi import FastAPI, APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import os, math, json, logging, asyncio, urllib.request, urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from cachetools import TTLCache

# Cache da 100 elementi, i dati durano 5 minuti (300 secondi)
cache = TTLCache(maxsize=100, ttl=300)
import numpy as np
import pandas as pd
import yfinance as yf

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

EMERGENT_LLM_KEY = os.environ.get("EMERGENT_LLM_KEY", "")

app = FastAPI(title="QUANT-EDGE Terminal API", version="2.0")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("quant-edge")

# ------------------------------------------------------------------
# 1. Utils
# ------------------------------------------------------------------
def _safe_row(df: pd.DataFrame, keys: List[str], col_idx: int = 0) -> float:
    if df is None or df.empty:
        return 0.0
    for k in keys:
        if k in df.index:
            try:
                v = df.loc[k].iloc[col_idx]
                if pd.isna(v):
                    continue
                return float(v)
            except Exception:
                continue
    return 0.0


def _series_row(df: pd.DataFrame, keys: List[str]) -> List[float]:
    if df is None or df.empty:
        return []
    for k in keys:
        if k in df.index:
            try:
                return [float(x) if not pd.isna(x) else 0.0 for x in df.loc[k].tolist()]
            except Exception:
                continue
    return []


def _fetch_live_price(t: yf.Ticker, info: dict) -> float:
    try:
        h = t.history(period="1d", interval="1m")
        if not h.empty:
            return float(h["Close"].iloc[-1])
    except Exception:
        pass
    try:
        h = t.history(period="5d")
        if not h.empty:
            return float(h["Close"].iloc[-1])
    except Exception:
        pass
    return float(info.get("currentPrice") or info.get("regularMarketPrice") or 100.0)


# ------------------------------------------------------------------
# 2. Data endpoint
# ------------------------------------------------------------------
_CACHE: Dict[str, Any] = {}
_CACHE_TTL = 300  # seconds


def _cache_get(key: str):
    v = _CACHE.get(key)
    if not v:
        return None
    ts, payload = v
    if (datetime.now(timezone.utc) - ts).total_seconds() > _CACHE_TTL:
        return None
    return payload


def _cache_set(key: str, payload):
    _CACHE[key] = (datetime.now(timezone.utc), payload)


@api.get("/asset/{ticker}")
async def get_asset(ticker: str):
    ticker = ticker.upper().strip()
    cached = _cache_get(f"asset:{ticker}")
    if cached:
        return cached
    try:
        t = yf.Ticker(ticker)
        info = t.info or {}
        if not info or not (info.get("shortName") or info.get("longName")):
            raise HTTPException(status_code=404, detail=f"Ticker {ticker} non trovato.")

        live = _fetch_live_price(t, info)
        is_df = t.income_stmt
        cf_df = t.cashflow
        bs_df = t.balance_sheet

        ebit = _safe_row(is_df, ["EBIT", "Operating Income"])
        revenue = _safe_row(is_df, ["Total Revenue", "TotalRevenue"])
        net_income = _safe_row(is_df, ["Net Income", "NetIncome"])
        gross_profit = _safe_row(is_df, ["Gross Profit"])
        da = _safe_row(cf_df, ["Depreciation And Amortization", "Depreciation"])
        capex = abs(_safe_row(cf_df, ["Capital Expenditures", "Capital Expenditure"]))
        nwc = _safe_row(cf_df, ["Changes In Working Capital", "Change In Working Capital"])
        cash = _safe_row(bs_df, ["Cash And Cash Equivalents", "Cash"])
        st_debt = _safe_row(bs_df, ["Current Debt", "Short Long Term Debt"])
        lt_debt = _safe_row(bs_df, ["Long Term Debt"])
        total_equity = _safe_row(bs_df, ["Stockholders Equity", "Total Stockholder Equity"])
        total_assets = _safe_row(bs_df, ["Total Assets"])
        net_debt = (st_debt + lt_debt) - cash

        shares = info.get("sharesOutstanding") or info.get("impliedSharesOutstanding") or 1_000_000_000
        beta = info.get("beta") or 1.15

        # Historical revenue series (up to 4y)
        rev_hist = _series_row(is_df, ["Total Revenue", "TotalRevenue"])
        ni_hist = _series_row(is_df, ["Net Income", "NetIncome"])

        # Price history 1Y
        try:
            hist = t.history(period="1y")
            price_hist = [
                {"date": idx.strftime("%Y-%m-%d"), "close": float(row["Close"])}
                for idx, row in hist.iterrows()
            ]
        except Exception:
            price_hist = []

        payload = {
            "ticker": ticker,
            "name": info.get("longName") or info.get("shortName") or ticker,
            "sector": info.get("sector") or "N/A",
            "industry": info.get("industry") or "N/A",
            "country": info.get("country") or "N/A",
            "employees": info.get("fullTimeEmployees") or 0,
            "currency": info.get("currency") or "USD",
            "exchange": info.get("exchange") or "N/A",
            "website": info.get("website") or "",
            "summary": info.get("longBusinessSummary") or "Descrizione societaria non disponibile.",
            "live_price": live,
            "previous_close": float(info.get("previousClose") or live),
            "day_high": float(info.get("dayHigh") or live),
            "day_low": float(info.get("dayLow") or live),
            "week52_high": float(info.get("fiftyTwoWeekHigh") or live),
            "week52_low": float(info.get("fiftyTwoWeekLow") or live),
            "shares_outstanding": float(shares),
            "beta": float(beta),
            "trailing_pe": float(info.get("trailingPE") or 0) or None,
            "forward_pe": float(info.get("forwardPE") or 0) or None,
            "ev_ebitda": float(info.get("enterpriseToEbitda") or 0) or None,
            "price_to_sales": float(info.get("priceToSalesTrailing12Months") or 0) or None,
            "price_to_book": float(info.get("priceToBook") or 0) or None,
            "dividend_yield": float(info.get("dividendYield") or 0),
            "dividend_rate": float(info.get("dividendRate") or 0),
            "payout_ratio": float(info.get("payoutRatio") or 0),
            "profit_margin": float(info.get("profitMargins") or 0),
            "roe": float(info.get("returnOnEquity") or 0),
            "roa": float(info.get("returnOnAssets") or 0),
            "revenue_growth": float(info.get("revenueGrowth") or 0),
            "earnings_growth": float(info.get("earningsGrowth") or 0),
            "target_mean": float(info.get("targetMeanPrice") or 0) or None,
            "recommendation": info.get("recommendationKey") or "N/A",
            "analyst_count": int(info.get("numberOfAnalystOpinions") or 0),
            "financials": {
                "ebit": ebit,
                "revenue": revenue,
                "net_income": net_income,
                "gross_profit": gross_profit,
                "da": da,
                "capex": capex,
                "nwc_change": nwc,
                "cash": cash,
                "st_debt": st_debt,
                "lt_debt": lt_debt,
                "net_debt": net_debt,
                "total_equity": total_equity,
                "total_assets": total_assets,
            },
            "revenue_history": rev_hist,
            "net_income_history": ni_hist,
            "price_history": price_hist,
        }
        _cache_set(f"asset:{ticker}", payload)
        return payload
    except HTTPException:
        raise
    except Exception as e:
        log.exception("asset fetch failed")
        raise HTTPException(status_code=500, detail=f"Errore: {e}")


# ------------------------------------------------------------------
# 3. News
# ------------------------------------------------------------------
@api.get("/news/{ticker}")
async def news(ticker: str, limit: int = 8):
    key = f"news:{ticker}:{limit}"
    cached = _cache_get(key)
    if cached:
        return cached
    articles = []
    try:
        q = urllib.parse.quote(f"{ticker} stock")
        url = f"https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=6) as r:
            root = ET.fromstring(r.read())
        for item in root.findall(".//item")[:limit]:
            title = item.find("title")
            link = item.find("link")
            pub = item.find("pubDate")
            src = item.find("source")
            articles.append({
                "title": title.text if title is not None else "",
                "link": link.text if link is not None else "",
                "publisher": src.text if src is not None else "Global Desk",
                "published": pub.text if pub is not None else "",
            })
    except Exception as e:
        log.warning("news failed: %s", e)
    _cache_set(key, articles)
    return articles


# ------------------------------------------------------------------
# 4. Macro (FRED — free, no key needed via fredgraph CSV)
# ------------------------------------------------------------------
@api.get("/macro")
async def macro():
    """Fetch macro indicators via yfinance (free, no key)."""
    cached = _cache_get("macro:all")
    if cached:
        return cached
    series = [
        ("^TNX", "US 10Y Yield"),
        ("^FVX", "US 5Y Yield"),
        ("^IRX", "US 3M T-Bill"),
        ("^VIX", "VIX Index"),
        ("DX-Y.NYB", "DXY (USD)"),
        ("GC=F", "Gold Futures"),
        ("CL=F", "WTI Crude"),
        ("BTC-USD", "Bitcoin"),
        ("^GSPC", "S&P 500"),
        ("^IXIC", "Nasdaq"),
    ]
    out = []
    for sym, name in series:
        try:
            info = yf.Ticker(sym).fast_info
            last = None
            try:
                last = float(info.get("last_price") or info.get("lastPrice") or 0)
            except Exception:
                pass
            if not last:
                h = yf.Ticker(sym).history(period="2d")
                if not h.empty:
                    last = float(h["Close"].iloc[-1])
            if last:
                out.append({"id": sym, "name": name, "value": last, "date": datetime.now(timezone.utc).strftime("%Y-%m-%d")})
        except Exception as e:
            log.warning("macro %s failed: %s", sym, e)
    _cache_set("macro:all", out)
    return out


# ------------------------------------------------------------------
# 5. Valuation engine
# ------------------------------------------------------------------
class ValuationRequest(BaseModel):
    ticker: str
    # Overrides
    ebit: float
    capex: float
    nwc_change: float
    net_debt: float
    da: float
    # WACC
    rf_rate: float
    erp: float
    tax_rate: float
    cost_of_debt: float
    beta: float
    # Growth
    g_stage_1: float
    g_stage_2: float
    perp_g: float
    exit_multiple: float
    # market context
    live_price: float
    shares_outstanding: float
    # Optional peer multiples for comps
    peer_pe: Optional[float] = None
    peer_ev_ebitda: Optional[float] = None
    peer_ps: Optional[float] = None
    revenue: Optional[float] = 0.0
    net_income: Optional[float] = 0.0
    # Dividend model
    dividend_rate: Optional[float] = 0.0


def _three_stage_dcf(base_flow, wacc, g1, g2, perp, exit_mult, shares, net_debt, ebitda):
    flows = []
    disc = []
    cur = base_flow
    for yr in range(1, 6):
        cur *= (1 + g1)
        flows.append(cur)
        disc.append(cur / (1 + wacc) ** yr)
    for yr in range(6, 11):
        cur *= (1 + g2)
        flows.append(cur)
        disc.append(cur / (1 + wacc) ** yr)
    pv_stages = sum(disc)
    if wacc > perp:
        tv_gordon = (flows[-1] * (1 + perp)) / (wacc - perp)
        pv_tv_gordon = tv_gordon / (1 + wacc) ** 10
        val_gordon = ((pv_stages + pv_tv_gordon) - net_debt) / shares if shares else float("nan")
    else:
        val_gordon = float("nan")
    terminal_ebitda = ebitda * ((1 + g1) ** 5) * ((1 + g2) ** 5)
    pv_tv_exit = (terminal_ebitda * exit_mult) / (1 + wacc) ** 10
    val_exit = ((pv_stages + pv_tv_exit) - net_debt) / shares if shares else float("nan")
    return val_gordon, val_exit, flows, disc


def _clean(x):
    if x is None:
        return None
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    return x


@api.post("/valuation")
async def valuation(req: ValuationRequest):
    # WACC
    mcap = req.live_price * req.shares_outstanding
    debt_pos = max(0.0, req.net_debt)
    total_cap = mcap + debt_pos
    w_e = mcap / total_cap if total_cap > 0 else 1.0
    w_d = debt_pos / total_cap if total_cap > 0 else 0.0
    ke = req.rf_rate + req.beta * req.erp
    kd_at = req.cost_of_debt * (1 - req.tax_rate)
    wacc = w_e * ke + w_d * kd_at

    # FCFF
    nopat = req.ebit * (1 - req.tax_rate)
    fcff = nopat + req.da - req.capex + req.nwc_change
    ebitda = req.ebit + req.da

    v_gordon, v_exit, flows, disc = _three_stage_dcf(
        fcff, wacc, req.g_stage_1, req.g_stage_2, req.perp_g, req.exit_multiple,
        req.shares_outstanding, req.net_debt, ebitda,
    )

    # Reverse DCF — solve for implied g1
    def _price_for_g1(g1):
        _, ve, _, _ = _three_stage_dcf(
            fcff, wacc, g1, req.g_stage_2, req.perp_g, req.exit_multiple,
            req.shares_outstanding, req.net_debt, ebitda,
        )
        return ve

    lo, hi = -0.30, 0.60
    mid = (lo + hi) / 2
    for _ in range(80):
        mid = (lo + hi) / 2
        if _price_for_g1(mid) < req.live_price:
            lo = mid
        else:
            hi = mid
    implied_g = mid

    # DDM (Gordon) — only meaningful if dividend > 0
    ddm_val = None
    if req.dividend_rate and req.dividend_rate > 0 and ke > req.perp_g:
        ddm_val = (req.dividend_rate * (1 + req.perp_g)) / (ke - req.perp_g)

    # Multiples-based valuations
    multiples = {}
    if req.peer_pe and req.net_income and req.shares_outstanding:
        eps = req.net_income / req.shares_outstanding
        multiples["pe"] = eps * req.peer_pe
    if req.peer_ev_ebitda and ebitda and req.shares_outstanding:
        ev = req.peer_ev_ebitda * ebitda
        multiples["ev_ebitda"] = (ev - req.net_debt) / req.shares_outstanding
    if req.peer_ps and req.revenue and req.shares_outstanding:
        multiples["ps"] = (req.peer_ps * req.revenue) / req.shares_outstanding

    # Weighted composite target
    components = []
    if _clean(v_exit) is not None:
        components.append(("DCF Exit Multiple", v_exit, 0.35))
    if _clean(v_gordon) is not None:
        components.append(("DCF Gordon", v_gordon, 0.25))
    for k, v in multiples.items():
        if v > 0:
            components.append((f"Multiples {k}", v, 0.15))
    if ddm_val:
        components.append(("DDM", ddm_val, 0.10))

    total_w = sum(w for _, _, w in components) or 1.0
    fair_composite = sum(v * w for _, v, w in components) / total_w if components else v_exit

    upside = ((fair_composite - req.live_price) / req.live_price) * 100 if req.live_price else 0
    rec = "BUY" if upside > 15 else ("SELL" if upside < -10 else "HOLD")

    return {
        "wacc": {
            "value": wacc,
            "cost_of_equity": ke,
            "after_tax_cost_of_debt": kd_at,
            "weight_equity": w_e,
            "weight_debt": w_d,
            "market_cap": mcap,
        },
        "dcf": {
            "fcff_base": fcff,
            "ebitda_base": ebitda,
            "flows": flows,
            "discounted": disc,
            "gordon_value": _clean(v_gordon),
            "exit_value": _clean(v_exit),
        },
        "reverse_dcf": {"implied_g1": implied_g},
        "ddm": {"value": _clean(ddm_val)},
        "multiples": {k: _clean(v) for k, v in multiples.items()},
        "composite": {
            "fair_value": fair_composite,
            "components": [{"name": n, "value": v, "weight": w / total_w} for n, v, w in components],
        },
        "recommendation": {
            "signal": rec,
            "upside_pct": upside,
            "target_price": fair_composite,
            "market_price": req.live_price,
        },
    }


# ------------------------------------------------------------------
# 6. Monte Carlo
# ------------------------------------------------------------------
class MonteCarloRequest(ValuationRequest):
    n_sims: int = 2000
    growth_vol: float = 0.035
    wacc_vol: float = 0.012
    seed: int = 42


@api.post("/montecarlo")
async def montecarlo(req: MonteCarloRequest):
    mcap = req.live_price * req.shares_outstanding
    debt_pos = max(0.0, req.net_debt)
    tot = mcap + debt_pos
    w_e = mcap / tot if tot > 0 else 1.0
    w_d = debt_pos / tot if tot > 0 else 0.0
    ke = req.rf_rate + req.beta * req.erp
    kd_at = req.cost_of_debt * (1 - req.tax_rate)
    wacc = w_e * ke + w_d * kd_at
    nopat = req.ebit * (1 - req.tax_rate)
    fcff = nopat + req.da - req.capex + req.nwc_change
    ebitda = req.ebit + req.da

    n = max(200, min(int(req.n_sims), 10000))
    rng = np.random.default_rng(req.seed)
    g_rand = rng.normal(req.g_stage_1, req.growth_vol, n)
    w_rand = rng.normal(wacc, req.wacc_vol, n)
    prices = np.empty(n)
    for i in range(n):
        _, ve, _, _ = _three_stage_dcf(
            fcff, max(0.02, w_rand[i]), g_rand[i], req.g_stage_2, req.perp_g,
            req.exit_multiple, req.shares_outstanding, req.net_debt, ebitda,
        )
        prices[i] = ve if not (math.isnan(ve) or math.isinf(ve)) else 0.0

    finite = prices[np.isfinite(prices) & (prices > 0)]
    if len(finite) == 0:
        return {"error": "Simulazione fallita: parametri estremi."}
    lo, hi = np.quantile(finite, [0.02, 0.98])
    trimmed = finite[(finite >= lo) & (finite <= hi)]
    p_under = float((trimmed > req.live_price).mean() * 100)

    # VaR / CVaR on returns vs market price
    returns = (trimmed - req.live_price) / req.live_price
    var_95 = float(np.quantile(returns, 0.05))
    cvar_95 = float(returns[returns <= var_95].mean()) if (returns <= var_95).any() else var_95

    # Histogram bins
    hist, edges = np.histogram(trimmed, bins=40)
    bins = [{"x": float((edges[i] + edges[i + 1]) / 2), "y": int(hist[i])} for i in range(len(hist))]

    return {
        "n_valid": int(len(trimmed)),
        "mean": float(trimmed.mean()),
        "median": float(np.median(trimmed)),
        "std": float(trimmed.std()),
        "p5": float(np.quantile(trimmed, 0.05)),
        "p25": float(np.quantile(trimmed, 0.25)),
        "p75": float(np.quantile(trimmed, 0.75)),
        "p95": float(np.quantile(trimmed, 0.95)),
        "market_price": req.live_price,
        "prob_undervalued": p_under,
        "var_95": var_95,
        "cvar_95": cvar_95,
        "histogram": bins,
    }


# ------------------------------------------------------------------
# 7. Sensitivity Heatmap
# ------------------------------------------------------------------
class SensitivityRequest(ValuationRequest):
    wacc_range: float = 0.03
    growth_range: float = 0.05
    steps: int = 7


@api.post("/sensitivity")
async def sensitivity(req: SensitivityRequest):
    mcap = req.live_price * req.shares_outstanding
    debt_pos = max(0.0, req.net_debt)
    tot = mcap + debt_pos
    w_e = mcap / tot if tot > 0 else 1.0
    w_d = debt_pos / tot if tot > 0 else 0.0
    ke = req.rf_rate + req.beta * req.erp
    kd_at = req.cost_of_debt * (1 - req.tax_rate)
    wacc_base = w_e * ke + w_d * kd_at
    nopat = req.ebit * (1 - req.tax_rate)
    fcff = nopat + req.da - req.capex + req.nwc_change
    ebitda = req.ebit + req.da

    steps = max(3, min(int(req.steps), 11))
    wacc_axis = np.linspace(wacc_base - req.wacc_range, wacc_base + req.wacc_range, steps)
    g_axis = np.linspace(req.g_stage_1 - req.growth_range, req.g_stage_1 + req.growth_range, steps)
    matrix = []
    for w in wacc_axis:
        row = []
        for g in g_axis:
            _, ve, _, _ = _three_stage_dcf(
                fcff, max(0.02, float(w)), float(g), req.g_stage_2, req.perp_g,
                req.exit_multiple, req.shares_outstanding, req.net_debt, ebitda,
            )
            row.append(float(ve) if math.isfinite(ve) else None)
        matrix.append(row)
    return {
        "wacc_axis": [float(x) for x in wacc_axis],
        "growth_axis": [float(x) for x in g_axis],
        "matrix": matrix,
        "market_price": req.live_price,
    }


# ------------------------------------------------------------------
# 8. Peer Benchmarking
# ------------------------------------------------------------------
@api.get("/peers/{ticker}")
async def peers(ticker: str):
    ticker = ticker.upper().strip()
    # Static curated peer map (free, no external calls) — fallback + curated for popular tickers
    peer_map = {
        "TSLA": ["F", "GM", "STLA", "TM", "NIO", "LI", "RIVN", "LCID"],
        "AAPL": ["MSFT", "GOOGL", "META", "AMZN", "SAMSUNG", "SONY"],
        "MSFT": ["AAPL", "GOOGL", "ORCL", "CRM", "IBM", "SAP"],
        "GOOGL": ["META", "MSFT", "AAPL", "AMZN", "PINS", "SNAP"],
        "META": ["GOOGL", "SNAP", "PINS", "TWTR", "MSFT", "AMZN"],
        "AMZN": ["WMT", "GOOGL", "MSFT", "TGT", "COST", "BABA"],
        "NVDA": ["AMD", "INTC", "AVGO", "QCOM", "MU", "TSM"],
        "AMD": ["NVDA", "INTC", "AVGO", "QCOM", "MU"],
        "NFLX": ["DIS", "WBD", "PARA", "AMZN", "AAPL", "SPOT"],
        "JPM": ["BAC", "C", "WFC", "GS", "MS", "HSBC"],
        "KO": ["PEP", "MNST", "KDP", "CELH"],
        "XOM": ["CVX", "SHEL", "BP", "TTE", "COP"],
    }
    peers_list = peer_map.get(ticker, [])
    if not peers_list:
        try:
            t = yf.Ticker(ticker)
            info = t.info or {}
            sector = info.get("sector") or ""
            defaults = {
                "Technology": ["AAPL", "MSFT", "GOOGL", "NVDA", "AMD"],
                "Consumer Cyclical": ["AMZN", "TSLA", "NKE", "MCD", "SBUX"],
                "Financial Services": ["JPM", "BAC", "GS", "MS", "WFC"],
                "Healthcare": ["JNJ", "PFE", "MRK", "UNH", "ABBV"],
                "Communication Services": ["META", "GOOGL", "NFLX", "DIS", "T"],
                "Energy": ["XOM", "CVX", "COP", "SHEL"],
            }
            peers_list = [p for p in defaults.get(sector, []) if p != ticker][:6]
        except Exception:
            peers_list = []

    rows = []
    for sym in [ticker] + peers_list[:6]:
        try:
            info = yf.Ticker(sym).info or {}
            rows.append({
                "ticker": sym,
                "name": info.get("shortName") or sym,
                "price": float(info.get("currentPrice") or info.get("regularMarketPrice") or 0),
                "market_cap": float(info.get("marketCap") or 0),
                "pe": float(info.get("trailingPE") or 0) or None,
                "forward_pe": float(info.get("forwardPE") or 0) or None,
                "ev_ebitda": float(info.get("enterpriseToEbitda") or 0) or None,
                "ps": float(info.get("priceToSalesTrailing12Months") or 0) or None,
                "profit_margin": float(info.get("profitMargins") or 0),
                "revenue_growth": float(info.get("revenueGrowth") or 0),
                "beta": float(info.get("beta") or 0),
                "roe": float(info.get("returnOnEquity") or 0),
                "is_target": sym == ticker,
            })
        except Exception:
            continue

    # Median peer multiples (excluding target)
    peers_only = [r for r in rows if not r["is_target"]]
    def _median(key):
        vs = [r[key] for r in peers_only if r.get(key)]
        return float(np.median(vs)) if vs else None

    medians = {
        "pe": _median("pe"),
        "forward_pe": _median("forward_pe"),
        "ev_ebitda": _median("ev_ebitda"),
        "ps": _median("ps"),
        "profit_margin": _median("profit_margin"),
        "revenue_growth": _median("revenue_growth"),
    }
    return {"rows": rows, "peer_medians": medians}


# ------------------------------------------------------------------
# 9. AI Research Narrative (Streaming SSE)
# ------------------------------------------------------------------
class AIResearchRequest(BaseModel):
    ticker: str
    name: str
    sector: str
    industry: str
    signal: str
    market_price: float
    target_price: float
    upside_pct: float
    wacc: float
    implied_g: float
    g_stage_1: float
    g_stage_2: float
    perp_g: float
    net_debt: float
    ebit: float
    ebitda: float
    revenue: float
    beta: float
    prob_undervalued: Optional[float] = None
    var_95: Optional[float] = None
    language: str = "it"  # "it" or "en"


@api.post("/ai/research")
async def ai_research(req: AIResearchRequest):
    if not EMERGENT_LLM_KEY:
        raise HTTPException(status_code=400, detail="EMERGENT_LLM_KEY non configurata.")
    try:
        from emergentintegrations.llm.chat import LlmChat, UserMessage, TextDelta, StreamDone
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"emergentintegrations non installata: {e}")

    lang_label = "italiano professionale" if req.language == "it" else "professional English"
    system_msg = (
        f"Sei un senior equity research analyst di livello CFA/istituzionale. "
        f"Scrivi in {lang_label} un report d'iniziazione di copertura in prosa densa, "
        f"strutturata come sell-side buy-side research (400-550 parole). "
        f"Usa terminologia finanziaria precisa (FCFF, WACC, terminal value, EV/EBITDA, moat, capital allocation). "
        f"NON usare markdown headings o bullet. Solo paragrafi ben articolati (3-4 paragrafi). "
        f"NON menzionare che sei un'AI. Firma finale: 'QUANT-EDGE Institutional Desk'."
    )
    prompt = (
        f"Redigi la tesi d'investimento per {req.name} ({req.ticker}) — settore {req.sector} / {req.industry}.\n\n"
        f"DATI CHIAVE:\n"
        f"- Raccomandazione: {req.signal}\n"
        f"- Prezzo di mercato: ${req.market_price:,.2f}\n"
        f"- Target Price (composite): ${req.target_price:,.2f}\n"
        f"- Upside/Downside: {req.upside_pct:+.2f}%\n"
        f"- WACC: {req.wacc*100:.2f}%\n"
        f"- Growth implicita di mercato (Reverse DCF): {req.implied_g*100:.2f}%\n"
        f"- Crescita Stage 1/2/Perp: {req.g_stage_1*100:.1f}% / {req.g_stage_2*100:.1f}% / {req.perp_g*100:.1f}%\n"
        f"- EBIT: ${req.ebit:,.0f} | EBITDA: ${req.ebitda:,.0f} | Revenue: ${req.revenue:,.0f}\n"
        f"- Net Debt: ${req.net_debt:,.0f} | Beta: {req.beta:.2f}\n"
    )
    if req.prob_undervalued is not None:
        prompt += f"- Prob. sottovalutazione (MC): {req.prob_undervalued:.1f}%\n"
    if req.var_95 is not None:
        prompt += f"- VaR 95%: {req.var_95*100:.2f}%\n"
    prompt += (
        "\nSTRUTTURA:\n"
        "Paragrafo 1 — Tesi d'investimento sintetica e catalyst principali.\n"
        "Paragrafo 2 — Assumptions del modello DCF (WACC, growth) e confronto con crescita implicita.\n"
        "Paragrafo 3 — Fattori di rischio (leverage, esposizione settoriale, ESG, supply chain).\n"
        "Paragrafo 4 — Conclusione con orizzonte 12 mesi e range di sensitivity."
    )

    chat = LlmChat(
        api_key=EMERGENT_LLM_KEY,
        session_id=f"research-{req.ticker}-{datetime.now(timezone.utc).timestamp()}",
        system_message=system_msg,
    ).with_model("anthropic", "claude-sonnet-4-6")

    async def gen():
        try:
            async for ev in chat.stream_message(UserMessage(text=prompt)):
                if isinstance(ev, TextDelta):
                    yield f"data: {json.dumps({'delta': ev.content})}\n\n"
                elif isinstance(ev, StreamDone):
                    yield f"data: {json.dumps({'done': True})}\n\n"
                    break
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no", "Connection": "keep-alive"},
    )


# ------------------------------------------------------------------
# 10. Health
# ------------------------------------------------------------------
@api.get("/")
async def root():
    return {"service": "QUANT-EDGE Terminal", "version": "2.0", "status": "operational"}


app.include_router(api)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)
