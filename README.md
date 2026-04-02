# SmartSpecs Finder

SmartSpecs Finder is a full-stack smartphone recommendation and analytics project.

- Backend: NestJS API for scraping, RAG, analytics preprocessing, and Text-to-SQL
- Frontend: Next.js chat dashboard with live matches and phone detail cards
- Data: Chroma vector search + SQLite analytics table (`phones_analytics`)

## Demo Video

Watch the project demo directly from this repository:

- [Project Demo (MP4)](./bandicam%202026-04-02%2018-35-38-506.mp4)

If GitHub does not preview the video inline in your browser, click the link above to open/download it.

## Project Structure

- `smart-specs/` -> backend (NestJS)
- `smart-deal-ui/` -> frontend (Next.js)
- `chroma-data/` -> local vector DB persistence

## Quick Start

### 1. Backend

```bash
cd smart-specs
npm install
npm run start
```

### 2. Frontend

```bash
cd smart-deal-ui
npm install
npm run dev
```

### 3. Optional services

Run Chroma server (if you want persistent vector storage):

```bash
chroma run --host localhost --port 8000 --path ./chroma-data
```

## Key Endpoints

- `POST /scraper/run` -> scrape and export phones
- `POST /rag/refresh-live` -> scrape + preprocess + SQL sync + index refresh
- `POST /rag/ask` -> main chat endpoint (SQL-first with fallback)
- `POST /rag/sql/ask` -> direct Text-to-SQL ask
- `POST /rag/sql/phone-details` -> full analytics row for a selected card

## Notes

- For best SQL generation quality, the backend uses Groq `llama-3.3-70b-versatile` with a few-shot SQL prompt.
- Card rendering is enriched from analytics rows so price/url/id are available even for aggregate-heavy queries.
