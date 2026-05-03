## Add "Saiba Mais" / Tópicos expansion to the scraper

### Goal
After the normal scrape pass, follow each confirmed match's related-articles block one level deep to surface articles like the Montenegro/cidadania piece that link to "sexualidade" content but don't contain the keyword in their own title/body. Strictly keep results inside the user's date range.

### Changes

**`src/server/searchArticles.ts`**
1. Add `extractRelatedLinks(html)` — parses the `#contentTopicos` ("Saiba Mais") block and returns absolute `https://rr.pt/...` article URLs (must contain `/YYYY/MM/DD/`).
2. In the main worker, when an article matches, also collect `extractRelatedLinks(html)` into a shared `relatedCandidates` set (skip URLs already scraped).
3. After the first pass:
   - Filter related candidates with `inDateRange(dateFromUrl(u), startDate, endDate)` — out-of-range URLs are dropped before any fetch.
   - Dedupe against already-scraped URLs.
   - Cap at `maxRelated` (default 200, hard max 500).
   - Run the same worker pool / keyword verification / post-scrape date check.
4. Stats: add `relatedDiscovered`, `relatedScraped`, `relatedMatched`.

**`src/routes/index.tsx`**
- Update Search description to mention related-article expansion.
- Display the new stats line: `… · {relatedScraped} related scraped · {relatedMatched} related matched`.
- Raise the `maxScrapes` input `max` attribute to 500 (currently mistakenly 200) so the existing field works as documented.

### Date-range guarantees (unchanged behavior, applied to new candidates too)
- Pre-fetch: URL-date filter via `dateFromUrl` + `inDateRange`.
- Post-fetch: `<meta article:published_time>` rechecked via `inDateRange` before pushing to results.

### Out of scope
- Multi-hop traversal (only 1 hop; deeper would explode candidates with little extra recall).
- Topic landing pages (`/topico/...`) — they 404 on rr.pt; per-article Saiba Mais is the reliable signal.

### Expected outcome
For "sexualidade" Oct 19 – Nov 23 2024: the Montenegro/cidadania article and its in-window siblings reached via Saiba Mais will now appear; out-of-window related links (e.g. July 2025, Dec 2024) are filtered out before scraping.
