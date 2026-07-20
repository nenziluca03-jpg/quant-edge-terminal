# 📈 QUANT-EDGE Institutional Investment Terminal

Questo repository contiene il codice sorgente completo del terminale di valutazione buy-side **QUANT-EDGE**, sviluppato interamente da zero nell'arco di una settimana.

## 📦 Contenuto del Repository
Per motivi di portabilità rapida, l'intero codice sorgente (Frontend in React e Backend in FastAPI) è racchiuso nel file d'archivio presente all'interno del repository:
* `quant-edge-source.zip`

## ✨ Funzionalità del Progetto
- **3-Stage DCF Model & Reverse DCF:** Algoritmo numerico per calcolare la crescita implicita nei prezzi di mercato attuali.
- **Monte Carlo Risk Engine:** 2.500 simulazioni stocastiche per il calcolo delle distribuzioni del Fair Value e metriche di rischio VaR / CVaR al 95%.
- **Peer Group Benchmarking:** Recupero automatico e calcolo delle mediane dei multipli di mercato dei concorrenti di settore.
- **AI Research Narrative:** Integrazione con Claude Sonnet 4.6 (tramite Emergent API) per la generazione in streaming di report di ricerca sell-side in prosa finanziaria complessa.

## 🛠️ Tech Stack
- **Frontend:** React 19, Tailwind CSS, Recharts, Lucide React.
- **Backend:** Python, FastAPI, Pydantic, NumPy, Pandas, yFinance.# quant-edge-terminal
