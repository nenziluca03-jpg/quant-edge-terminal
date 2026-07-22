import os
import logging
from typing import Dict, Any, List
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
import yfinance as yf
from cachetools import TTLCache
import requests

# ------------------------------------------------------------------------------
# LOGGING
# ------------------------------------------------------------------------------
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("QuantEdgeBackend")

# ------------------------------------------------------------------------------
# SESSIONE PERSONALIZZATA (Bypassa i blocchi IP / Rate Limit di Yahoo Finance)
# ------------------------------------------------------------------------------
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
})

# ------------------------------------------------------------------------------
# CACHE (In-Memory, TTL 300 secondi / 5 minuti)
# ------------------------------------------------------------------------------
cache = TTLCache(maxsize=500, ttl=300)

def _cache_get(key: str):
    return cache.get(key)

def _cache_set(key: str, value: Any):
    cache[key] = value

# ------------------------------------------------------------------------------
# FASTAPI APP (Rinominata in 'app' per Render)
# ------------------------------------------------------------------------------
app = FastAPI(title="Quant Edge Terminal API", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
# HELPER FUNCTIONS
# ------------------------------------------------------------------------------
def _fetch_live_price(t: yf.Ticker, info: dict) -> float:
    try:
        price = info.get("currentPrice") or info.get("regularMarketPrice") or info.get("previousClose")
        if price:
            return float(price)
        
        h = t.history(period="1d")
        if not h.empty:
            return float(h["Close"].iloc[-1])
    except Exception as e:
        log.warning("Impossibile recuperare prezzo live: %s", e)
    
    return float(info.get("previousClose") or 100.0)

# ------------------------------------------------------------------------------
# ENDPOINTS
# ------------------------------------------------------------------------------
@app.get("/")
def root():
    return {"status": "ok", "message": "Quant Edge Terminal Backend Operational"}

@app.get("/asset/{ticker}")
def get_asset(ticker: str):
    ticker = ticker.upper().strip()
    cache_key = f"asset:{ticker}"
    
    cached_data = _cache_get(cache_key)
    if cached_data:
        return cached_data

    try:
        t = yf.Ticker(ticker, session=session)
        info = t.info or {}
        
        if not info or "shortName" not in info:
            raise HTTPException(status_code=404, detail="Ticker non trovato o privo di dati.")

        live_price = _fetch_live_price(t, info)
        
        data = {
            "symbol": ticker,
            "name": info.get("shortName", ticker),
            "price": live_price,
            "change": float(info.get("regularMarketChangePercent", 0.0) or 0.0),
            "marketCap": info.get("marketCap", 0),
            "peRatio": info.get("trailingPE"),
            "forwardPE": info.get("forwardPE"),
            "eps": info.get("trailingEps"),
            "beta": info.get("beta"),
            "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
            "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
            "sector": info.get("sector", "N/A"),
            "industry": info.get("industry", "N/A"),
            "summary": info.get("longBusinessSummary", "Nessuna descrizione disponibile.")
        }

        _cache_set(cache_key, data)
        return data

    except Exception as e:
        log.error("Errore recupero asset %s: %s", ticker, e)
        raise HTTPException(status_code=429, detail="Impossibile recuperare i dati al momento (Rate Limit Yahoo). Riprova tra 1-2 minuti.")

@app.get("/news/{ticker}")
def get_news(ticker: str):
    ticker = ticker.upper().strip()
    cache_key = f"news:{ticker}"
    
    cached_data = _cache_get(cache_key)
    if cached_data:
        return cached_data

    try:
        t = yf.Ticker(ticker, session=session)
        raw_news = t.news or []
        
        formatted_news = []
        for item in raw_news[:5]:
            formatted_news.append({
                "title": item.get("title", ""),
                "publisher": item.get("publisher", ""),
                "link": item.get("link", ""),
                "providerPublishTime": item.get("providerPublishTime", 0)
            })

        _cache_set(cache_key, formatted_news)
        return formatted_news

    except Exception as e:
        log.error("Errore recupero news per %s: %s", ticker, e)
        return []

@app.get("/macro")
def get_macro():
    cache_key = "macro_indicators"
    cached_data = _cache_get(cache_key)
    if cached_data:
        return cached_data

    tickers = {
        "S&P 500": "^GSPC",
        "Nasdaq": "^IXIC",
        "VIX": "^VIX",
        "US 10Y Yield": "^TNX",
        "EUR/USD": "EURUSD=X",
        "Gold": "GC=F"
    }

    results = []
    for name, sym in tickers.items():
        try:
            t = yf.Ticker(sym, session=session)
            info = t.info or {}
            price = _fetch_live_price(t, info)
            results.append({
                "name": name,
                "symbol": sym,
                "price": price,
                "change": float(info.get("regularMarketChangePercent", 0.0) or 0.0)
            })
        except Exception:
            results.append({"name": name, "symbol": sym, "price": 0.0, "change": 0.0})

    _cache_set(cache_key, results)
    return results

@app.get("/peers/{ticker}")
def get_peers(ticker: str):
    ticker = ticker.upper().strip()
    cache_key = f"peers:{ticker}"
    
    cached_data = _cache_get(cache_key)
    if cached_data:
        return cached_data

    try:
        t = yf.Ticker(ticker, session=session)
        info = t.info or {}
        sector = info.get("sector")
        
        default_peers = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA"]
        
        _cache_set(cache_key, default_peers)
        return default_peers
    except Exception:
        return ["AAPL", "MSFT", "GOOGL"]
        
        _cache_set(cache_key, default_peers)
        return default_peers
    except Exception:
        return ["AAPL", "MSFT", "GOOGL"]
