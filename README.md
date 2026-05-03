rr.pt Article Scraper
How the scraper discovers, verifies, and returns articles — end-to-end technical explanation
1. What the tool does
The application searches for articles published on rr.pt (Rádio Renascença) that match one or more keywords within a user-defined date range, then exports the results to Excel. It is a server-side scraper: all network calls and HTML parsing happen on the server, and only the final list of matching articles is returned to the browser.
The user provides three inputs:
•	One or more keywords (comma-separated).
•	A start and end date (optional, but recommended).
•	A maximum number of articles to scrape per pass (default 200, max 500).
The output is a list of articles, each with URL, title, author, publish date, a snippet, and a tag indicating where the keyword was found (title, URL, description, or body).
2. The core problem
rr.pt does not expose a public search API. Its on-site search is JavaScript-rendered and not directly scrapable. The site does, however, publish:
•	A sitemap index (sitemapindex.xml) that links to monthly sitemaps.
•	Monthly sitemaps that list every article URL, with the publish date encoded in the URL path (/YYYY/MM/DD/slug/id/).
A typical month contains roughly 8,000 articles. Brute-force scraping every URL in a date window to check for keywords is not feasible on a serverless runtime — it would take many minutes per query and likely time out. We therefore need smarter discovery: ways to identify, before scraping, which URLs are likely to match.
3. The four-stage pipeline
Each search runs through four sequential stages: discovery, candidate building, verification (first pass), and related-article expansion (second pass).
Stage 1 — Discovery
Two parallel sources are used to collect candidate URLs.
3.1 DuckDuckGo full-text search
DuckDuckGo's HTML endpoint (html.duckduckgo.com) is queried with site:rr.pt followed by the keyword. Because DuckDuckGo indexes the full body of each article, this returns URLs where the keyword appears anywhere on the page — title, body, or URL — not just in the slug.
Implementation details:
•	Queries are paginated (up to 5 pages, 30 results per page) until no new URLs appear.
•	Results are wrapped in a redirect format (//duckduckgo.com/l/?uddg=...). The scraper decodes the uddg parameter to recover the original rr.pt URL.
•	Only URLs matching https://rr.pt/ and containing a /YYYY/MM/DD/ date segment are kept (filters out tag pages, the homepage, etc.).
•	A 250 ms delay is added between pages to be polite to the endpoint.
•	If DuckDuckGo fails or returns nothing, the pipeline continues with sitemap-only discovery.
3.2 Sitemap supplement
DuckDuckGo's index lags real-time by hours or days for very fresh articles. To catch those, the scraper also reads rr.pt's monthly sitemaps:
1.	Fetch sitemapindex.xml and identify the monthly sitemaps overlapping the user's date range.
2.	Fetch each monthly sitemap in parallel and extract every article URL.
3.	Filter to URLs whose date segment falls inside the user's date window.
4.	From those, keep the ones whose URL slug contains any of the keywords (slug-matches). These are very high-confidence candidates.
Stage 2 — Candidate building
DuckDuckGo URLs (filtered to date range) and sitemap slug-matches are merged and deduplicated. The merged list is capped at the user's “max articles to scrape” limit. This is the first-pass scrape list.
Stage 3 — Verification (first pass)
Every candidate URL is fetched in parallel (10 concurrent workers). For each article, the scraper:
1.	Downloads the HTML.
2.	Extracts the title from <meta property="og:title"> (with fallbacks to <title> and twitter:title).
3.	Extracts the meta description from og:description, name="description", or twitter:description.
4.	Extracts the publish date from article:published_time and several other meta tags, falling back to the date in the URL.
5.	Extracts the author from author / article:author meta tags, with a heuristic fallback that searches for “Por <Name>” in the first 2,000 characters of the body.
6.	Strips all HTML tags to produce clean body text.
It then runs the keyword check against four “haystacks” — title, description, URL slug, and body text — and records which ones matched. If none match, the article is discarded. The publish date is then re-checked against the user's date range. Only articles that pass both checks are added to the results.
Stage 4 — Related-article expansion (second pass)
Many rr.pt articles include a “Saiba Mais” / Tópicos block listing related stories. An article about “educação cidadã” may not contain the word “sexualidade” in its own text, but it will often link to articles about sexuality in its related-articles section — and rr.pt's own search treats it as a match for that reason.
To capture this, while scraping each first-pass article the scraper also extracts every link inside the #contentTopicos block. After the first pass completes:
5.	Related URLs already scraped are removed.
1.	URLs whose date segment falls outside the user's date range are filtered out before any fetch (the URL alone tells us its date).
2.	The remaining list is capped (default 200, max 500).
3.	These URLs are scraped through the same worker pool, with the same keyword and date verification.
Only one hop is followed. Going deeper would explode the candidate set without meaningfully improving recall.
4. Date-range guarantees
Articles outside the requested range never reach the results, regardless of how they were discovered. Two independent filters enforce this:
•	Pre-fetch filter: URL date (parsed from /YYYY/MM/DD/) must fall inside the range. URLs that fail are dropped before any HTTP request.
•	Post-fetch filter: the actual <meta article:published_time> from the HTML is parsed and re-checked against the range. Anything outside is discarded even if its URL date suggested otherwise.
Date parsing uses UTC throughout to avoid timezone drift on day boundaries.
5. Keyword matching
Matching is case- and accent-insensitive. Both the keyword and the haystack are normalised by lowercasing and stripping diacritics (NFD + combining-mark removal). “Sexualidade”, “sexualidade”, and “SEXUALIDADE” all match the same way.
Keyword expansion
Portuguese abstract nouns ending in -idade often appear in articles only via their adjective root. To mirror how rr.pt's own search behaves, the scraper expands each keyword:
•	“sexualidade” → also matches “sexual”
•	“identidade” → also matches “ident” (rare, but kept for symmetry)
Variants shorter than 4 characters are discarded to avoid noisy matches.
6. HTML parsing
Parsing is done with regular expressions rather than a full DOM parser, for speed and to avoid heavy dependencies in the serverless runtime. Specifically:
•	Meta tags are read via regex matching both attribute orders (name=...content=... and content=...name=...).
•	HTML entities (&amp;, &#x201C;, etc.) are decoded after extraction.
•	Body text is produced by removing <script>, <style>, and <noscript> blocks first, then stripping remaining tags and collapsing whitespace.
•	Related links are extracted from the #contentTopicos block, normalised to absolute URLs, and filtered to those containing a /YYYY/MM/DD/ date segment.
7. Concurrency, politeness, and limits
•	HTTP requests use a custom User-Agent identifying the bot.
•	Article fetches run with 10 concurrent workers per pass.
•	DuckDuckGo pagination is sequential per keyword with a 250 ms delay.
•	Per-search caps: maxScrapes (5–500, default 200) for the first pass; the same cap is reused for the related pass.
•	Failed fetches are counted and reported in the result stats but never abort the search.
8. What the user sees
After a search, the UI displays:
•	A results table: title, author, date, where the match was found, and a link to open the article.
•	A statistics line showing: DuckDuckGo hits, sitemaps scanned, URLs in range, slug-matches, articles scraped, related articles scraped and matched, and total matches.
•	An “Export Excel” button that produces a .xlsx file with URL, title, author, and date for every result.
9. Known limitations
•	DuckDuckGo's HTML endpoint is unofficial. If it ever blocks the request, recall drops to sitemap-slug-matches plus the related-article expansion of those.
•	Articles where the keyword appears only in body text and that are not linked from any other in-range article will be missed unless DuckDuckGo has indexed them.
•	Related-article expansion follows only one hop. Articles two or more hops away are not reached.
•	rr.pt topic landing pages (e.g. /topico/sexualidade) currently return 404, so they cannot be used as seed lists.
•	Author extraction depends on meta tags or a “Por <Name>” pattern; some older articles may have an empty author field.
10. End-to-end example
Search: keyword “sexualidade”, range 19 Oct 2024 – 23 Nov 2024.
1.	Stage 1a — DuckDuckGo returns ~12 rr.pt URLs containing “sexualidade” in title or body.
2.	Stage 1b — Sitemaps for 2024-10 and 2024-11 are downloaded; ~16,000 URLs in range; slug-match filter keeps ~1 URL containing the literal keyword in the slug.
3.	Stage 2 — Lists are merged, deduped, and capped: ~12 candidates.
4.	Stage 3 — Each is fetched, verified, and dated; ~10–12 confirmed matches survive.
5.	Stage 4 — Each match's Saiba Mais block contributes ~15–20 related URLs. After date and dedupe filters, ~50–100 remain. They are scraped; a handful (e.g. the Montenegro / cidadania article that links to sexualidade pieces) match and are added.
6.	Final result: roughly 12–20 articles, all inside the requested date window, sorted newest first.
