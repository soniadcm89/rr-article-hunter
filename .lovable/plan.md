## Why so few results

I reproduced the issue. For "sexualidade" across Aug–Oct 2025, rr.pt's monthly sitemaps list **~8,000 articles**, but only **1** has the keyword in its URL slug. The remaining 11 articles you found manually have the keyword only in the **body text**.

The current scraper:
1. Pulls every URL from the monthly sitemaps in your date range.
2. Pre-filters by slug (URL match) — finds 1.
3. Then fetches up to `maxScrapes` (default 80) of the remaining ~8,000 URLs in arbitrary order, hoping to stumble on body matches.

With ~8,000 candidates and an 80-fetch budget, the chance of hitting the other 11 articles is basically zero. Scraping all 8,000 would take ~15 minutes per query and is not realistic on the serverless runtime.

## Fix: use a real search engine to find body matches

Instead of brute-forcing the sitemap, we ask **DuckDuckGo's HTML endpoint** (no API key, no rate-limited account) for `site:rr.pt <keyword>`. I tested it live — for "sexualidade" it immediately returns 10+ correct rr.pt article URLs, including ones where the keyword appears only in the body.

DuckDuckGo becomes the primary discovery source; the sitemap remains a fallback so we don't miss very recent articles that aren't indexed yet.

## What changes

`src/server/searchArticles.ts`:
1. **New `ddgSearch(keyword)` helper** — fetches `https://html.duckduckgo.com/html/?q=site:rr.pt+<keyword>` and follows pagination (`s=0`, `s=30`, `s=60`…) up to ~5 pages per keyword (~150 URLs each). Extracts and normalises rr.pt article URLs (decodes the `uddg=` redirect wrapper if present).
2. **Per-keyword discovery** — run `ddgSearch` for each keyword in parallel, union the results.
3. **Date-range filter** — keep URLs whose date segment falls in the user's range (uses existing `dateFromUrl`).
4. **Sitemap as supplement** — still scan monthly sitemaps for slug matches, so brand-new articles not yet in DDG's index are not missed. Union both sources.
5. **Scrape & verify** — fetch each candidate's HTML and run the existing keyword match against title / description / URL / body. This confirms the match and extracts author + publish date.
6. **Bump default `maxScrapes`** from 80 to 200 (the candidate set is now small and targeted, not 8,000 random URLs).
7. **Update stats**: replace the obsolete `firecrawlHits` counter with `ddgHits`, and keep `slugMatches`, `urlsInRange`, etc.
8. **Politeness**: 1 small delay between DDG pages, custom User-Agent, gracefully skip if DDG returns 0 results or errors (fall back to sitemap-only behaviour).

`src/routes/index.tsx`:
- Update the description text under "Search" to mention DuckDuckGo + sitemaps (no Firecrawl).
- Update the stats line to show `ddgHits` instead of `firecrawlHits`.
- Default `maxScrapes` state from 80 → 200; keep max at 500.

## Expected outcome

For your "sexualidade" test: instead of 1 result, you should now get the ~12 you found manually, because DDG surfaces them by full-text and we then scrape each to confirm + extract metadata.

## Caveats

- DuckDuckGo HTML is unofficial. If they ever block our IP, the tool falls back to sitemap+slug discovery (current behaviour). We can add a Bing fallback later if needed.
- DDG's index typically lags real-time by a few hours/days for very fresh articles — the sitemap supplement covers that gap.
- No new dependencies, no API keys, no cost.