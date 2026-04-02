# SmartSpecs Finder

SmartSpecs Finder is an end-to-end smartphone intelligence system that goes from live web scraping to analytics-ready data, then serves both recommendation chat (RAG) and structured analytics answers (Text-to-SQL) in one interface.

## Demo Video

<video src="./bandicam%202026-04-02%2018-35-38-506.mp4" controls="controls" width="100%"></video>

If GitHub does not render video preview in your browser, open the file from the link above.

## What We Built

This project was built as a complete data and AI pipeline:

1. Scrape smartphone listings and specs from live e-commerce pages.
2. Export the scraped dataset to Excel for reproducibility.
3. Normalize and preprocess raw specs into analytics-friendly columns.
4. Sync normalized data into a SQLite analytics table.
5. Index enriched phone documents into a vector database for semantic retrieval.
6. Serve user questions through an API that supports both:
	 - RAG recommendations (for conversational buying guidance)
	 - Text-to-SQL analytics (for precise numeric/business-style questions)
7. Visualize answers in a Next.js dashboard with match cards and click-to-view detailed phone analytics.

## Full Data Flow (Scraping -> Analytics -> RAG)

### 1) Live Scraping

- Scraper collects phone records including name, price, URL, colors, storage options, and detailed specs.
- Data is exported to `exports/*.xlsx`.

### 2) Analytics Preprocessing

- Raw specs are transformed into normalized features like:
	- battery mAh
	- refresh rate
	- screen size
	- camera MP
	- RAM and storage
	- 5G/NFC/WiFi/Bluetooth flags
- This produces analytics-ready sheets and machine-friendly structured rows.

### 3) SQL Analytics Layer

- Normalized rows are loaded into SQLite table `phones_analytics`.
- Text-to-SQL uses Groq + LangChain with few-shot prompting.
- Common high-impact queries (for example highest/lowest battery or cheapest brand) use deterministic SQL for reliability.
- Complex long-tail questions are generated dynamically through LLM SQL generation.

### 4) RAG Recommendation Layer

- Enriched phone text is embedded and indexed into Chroma (or in-memory fallback if Chroma is unavailable).
- Constraint-aware retrieval handles brand, budget, and feature cues.
- LLM returns grounded recommendations from retrieved phone context.

### 5) Unified Ask Endpoint

- Main chat endpoint (`POST /rag/ask`) attempts SQL-first where appropriate.
- If SQL is not a good fit, it falls back to RAG.
- SQL results are enriched so UI cards can still show price, URL, and IDs consistently.

### 6) Frontend Experience

- Chat answers appear in real time.
- Database match cards update immediately after each response.
- Clicking a card loads full analytics details from SQLite (not just summary text).

## Technologies Used

### Backend

- NestJS (TypeScript)
- LangChain
- Groq LLMs (`llama-3.3-70b-versatile` for SQL reasoning)
- SQLite + TypeORM
- Chroma vector database
- ExcelJS (data export and analytics workbook generation)
- Selenium/ChromeDriver (web scraping)

### Frontend

- Next.js 16 (App Router)
- React + TypeScript
- Tailwind CSS
- Client-side fetch-based API integration
- Responsive dashboard layout with chat panel, matches grid, and details panel

## Project Structure

- `smart-specs/` -> backend API and data pipeline
- `smart-deal-ui/` -> frontend dashboard
- `chroma-data/` -> local Chroma persistence

## Quick Start

### 1. Start Backend

```bash
cd smart-specs
npm install
npm run start
```

### 2. Start Frontend

```bash
cd smart-deal-ui
npm install
npm run dev
```

### 3. Start Chroma (Optional but recommended)

```bash
chroma run --host localhost --port 8000 --path ./chroma-data
```

## Key API Endpoints

- `POST /scraper/run` -> scrape and export phones
- `POST /rag/update-database` -> ingest latest Excel into vector index
- `POST /rag/preprocess-analytics` -> generate normalized analytics workbook
- `POST /rag/sql/sync` -> sync analytics workbook into SQLite table
- `POST /rag/sql/ask` -> direct Text-to-SQL query endpoint
- `POST /rag/sql/phone-details` -> get full analytics row for selected card
- `POST /rag/refresh-live` -> one-click scrape + preprocess + SQL sync + index refresh
- `POST /rag/ask` -> unified chat endpoint (SQL-first with fallback)

## Suggested Demo Questions

- `cheapest samsung phone`
- `which phone has highest battery`
- `which apple phone has lowest battery`
- `find all apple phones with battery less than 4000 mah order by most expensive`
- `what is the average price of phones with 120hz displays`
- `recommend a gaming phone under 100k`

## Notes

- SQL answers are used for precision analytics.
- RAG answers are used for conversational recommendations.
- Card data is normalized so UI cards stay consistent even when SQL returns aggregate-heavy results.
