# RR Article Hunter — How the app works

A complete, end-to-end explanation of what the app does, how it discovers and verifies articles, the query language it understands, and its known limitations.

---

## 1. What the app does

RR Article Hunter searches articles published on **rr.pt** (Rádio Renascença) that match one or more user-supplied queries within a date range, and lets the user export the results to Excel.

It is a **server-side scraper**: all network calls and HTML parsing run on the server (TanStack Start server functions on a Cloudflare Worker). The browser only receives the final, verified list of matching articles.

The user provides:

- **One or more queries**, comma-separated. Each query can be a single keyword, a multi-word phrase, an exact-quoted phrase, or a boolean expression (see §3).
- **Start and end dates** (optional but strongly recommended).
- **Max articles to scrape per pass** (default 200, max 500).

The output is a table where each row contains: URL, title, author, publish date, snippet, and a tag indicating where the match was found (title, URL, description, body) — plus an **Export Excel** button.

---

## 2. The core problem

rr.pt does not expose a public search API. Its on-site search is JavaScript-rendered and not directly scrapable. The site does, however, publish:

- A **sitemap index** (`sitemapindex.xml`) listing monthly sitemaps.
- **Monthly sitemaps** containing every article URL, with the publish date encoded in the URL path: `/YYYY/MM/DD/slug/id/`.

A typical month has ~8,000 articles. Brute-force scraping every URL in a date range would take many minutes and time out the serverless runtime. The app therefore relies on **smart discovery** to identify likely matches *before* scraping.

---

## 3. The query language

Each comma-separated query is parsed independently. The parser supports:

| Syntax | Behaviour |
|---|---|
| `cidadania` | Single term. Includes `-idade(s)` stem expansion (e.g. `sexualidade` also matches `sexual`). |
| `aulas de cidadania` | **Multi-word bare input is treated as an exact phrase by default** — fast and precise. |
| `"educação sexual"` | Explicit exact phrase (quotes optional but supported). |
| `A AND B` | Both terms must appear anywhere in the article. |
| `A OR B` | Either term qualifies. |
| `A NOT B` | A required, B forbidden. |
| Mixed: `"educação sexual" OR cidadania NOT autárquicas` | Combined freely. |

**Stopwords** (`de`, `da`, `do`, `e`, `a`, `o`, `em`, `na`, `no`, `para`, `por`, `com`, …) are stripped only inside explicit `AND` clauses — never inside phrases or single bare words.

**OR-clause cap**: max **4 OR groups** per query, to bound the number of DuckDuckGo calls.

**Internal representation** (after `parseQuery`):

```
ParsedQuery = {
  orGroups:  [{ andTerms: [{ variants, display }, …] }, …],
  notTerms:  [{ variants, display }, …],
  ddgQueries: string[],   // one per OR-group, phrases auto-quoted
  summary:    string[]    // chips shown in the UI
}
```

The UI shows parsed-query chips below the input so users can confirm how their input was interpreted.

---

## 4. The four-stage pipeline

Every search runs through four sequential stages.

### Stage 1 — Discovery

Two sources run in parallel.

**4.1 DuckDuckGo full-text search**

DuckDuckGo's HTML endpoint (`html.duckduckgo.com`) is queried with `site:rr.pt <query>`, **one query per OR-group** (phrases auto-quoted). DuckDuckGo indexes the article body, so it returns matches anywhere on the page — title, body, or URL.

- Paginated up to 5 pages × 30 results until no new URLs appear.
- Results are wrapped in a redirect (`//duckduckgo.com/l/?uddg=…`); the `uddg` param is decoded back to the original `rr.pt` URL.
- Only URLs matching `https://rr.pt/` and containing `/YYYY/MM/DD/` are kept (filters out tag pages, the homepage, etc.).
- 250 ms delay between pages.
- If DuckDuckGo fails or returns nothing, the pipeline falls back to sitemap-only discovery.

**4.2 Sitemap supplement**

DuckDuckGo's index lags real-time by hours or days for very fresh articles. To catch those:

1. Fetch `sitemapindex.xml` and identify monthly sitemaps overlapping the date range.
2. Fetch each monthly sitemap in parallel and extract article URLs.
3. Filter to URLs whose date segment falls inside the range.
4. From those, run the slug through `matchQueryInText` for each parsed query — keep slug-matches as high-confidence candidates.

### Stage 2 — Candidate building

DuckDuckGo URLs (filtered to date range) and sitemap slug-matches are merged, deduplicated, and capped at the user's `maxScrapes` limit. This is the **first-pass scrape list**.

### Stage 3 — Verification (first pass)

Every candidate URL is fetched in parallel (10 concurrent workers). For each article, the scraper:

1. Downloads the HTML.
2. Extracts **title** from `<meta property="og:title">` (with fallbacks).
3. Extracts **description** from `og:description` / `name="description"` / `twitter:description`.
4. Extracts **publish date** from `article:published_time` and similar meta tags, falling back to the URL date.
5. Extracts **author** from `author` / `article:author` meta tags, with a "Por <Name>" heuristic on the first 2,000 characters.
6. Strips `<script>`, `<style>`, `<noscript>` and remaining tags to produce clean body text.

It then runs **`matchQueryInText`** against four haystacks — title, description, URL slug, and body — and runs **`notTermsHit`** against the body/description haystack. An article passes only if:

- **All AND terms** in at least one OR-group appear in the haystack, AND
- **No NOT terms** appear in the body/description.

Date is then re-checked against the requested range. Surviving articles are added to the result set with `matchedIn` indicating where the match was found.

### Stage 4 — Related-article expansion (one hop)

Many rr.pt articles include a "Saiba Mais" / Tópicos block linking related stories. An article about *educação cidadã* may not literally contain "sexualidade" but link to articles that do — and rr.pt's own search treats those as matches.

While scraping each first-pass article, the app extracts every link inside `#contentTopicos`. After the first pass:

1. Already-scraped URLs are removed.
2. URLs whose date segment falls outside the requested range are dropped before any fetch (the URL alone reveals its date).
3. The remaining list is capped at `maxScrapes`.
4. Each URL is fetched and verified through the **same** `matchQueryInText` + `notTermsHit` pipeline.

Only **one hop** is followed — going deeper explodes the candidate set without meaningfully improving recall.

---

## 5. Date-range guarantees

Articles outside the requested range never reach the results. Two independent filters enforce this:

- **Pre-fetch**: URL date (parsed from `/YYYY/MM/DD/`) must fall inside the range. Failing URLs are dropped before any HTTP request.
- **Post-fetch**: the actual `<meta article:published_time>` is parsed and re-checked. Anything outside is discarded even if its URL date suggested otherwise.

All date arithmetic uses UTC to avoid timezone drift on day boundaries.

---

## 6. Matching rules

Matching is **case- and accent-insensitive**. Query and haystack are normalised: lowercase + NFD + combining-mark removal. So `Sexualidade`, `sexualidade`, `SEXUALIDADE` all match the same way.

**Stem expansion**: Portuguese abstract nouns ending in `-idade` / `-idades` are expanded to their adjective root. For example `sexualidade → sexual`. Variants shorter than 4 chars are discarded to avoid noise. Stem expansion applies only to single bare words — never to phrases or operator clauses.

**Phrase matching**: phrases are matched as substrings of the normalised haystack (with word boundaries handled by the surrounding context).

**NOT terms** cause rejection only when found in body or description — never when matched solely in slug or title (which are too short to safely exclude on).

---

## 7. HTML parsing

Parsing uses regular expressions rather than a DOM parser, for speed and to keep the serverless runtime light:

- Meta tags read via regex matching both attribute orders (`name=…content=…` and `content=…name=…`).
- HTML entities (`&amp;`, `&#x201C;`, …) decoded after extraction.
- Body text produced by removing `<script>`, `<style>`, `<noscript>`, then stripping remaining tags and collapsing whitespace.
- Related links extracted from `#contentTopicos`, normalised to absolute URLs, filtered to those containing a `/YYYY/MM/DD/` segment.

---

## 8. Concurrency, politeness, and limits

- Custom User-Agent identifying the bot.
- 10 concurrent workers per scrape pass.
- DuckDuckGo pagination is sequential per OR-group with a 250 ms delay.
- `maxScrapes` (5–500, default 200) caps the first pass; the same cap is reused for the related pass.
- Failed fetches are counted in the result stats but never abort the search.

---

## 9. The user interface

- **Query input**: comma-separated. Helper text and chips show how each query was parsed.
- **Date pickers**: text input accepts `yyyy-MM-dd`, `dd/MM/yyyy`, or `dd-MM-yyyy`; the popover calendar supports month and year dropdown navigation for fast jumps across years.
- **Max scrapes**: numeric input (5–500).
- **Results table**: title, author, date, where the match was found, link to the article.
- **Stats line**: DuckDuckGo hits, sitemaps scanned, URLs in range, slug-matches, articles scraped, related articles scraped and matched, total matches, plus the parsed-query summary for each input query.
- **Export Excel**: produces a `.xlsx` with URL, title, author, and date for every result.

---

## 10. Performance characteristics

- **Single-word queries**: same speed as before — one DDG search + sitemap pass.
- **Default phrase queries** (`aulas de cidadania`): same speed as a single keyword, but much more precise.
- **Explicit `AND` across common words**: ~2× scrape volume, mitigated by stopword stripping and the slug pre-filter.
- **`OR` queries**: linear in the number of OR clauses, capped at 4.
- **Related-article expansion**: unchanged; benefits more from richer queries.

---

## 11. Known limitations

- **DuckDuckGo's HTML endpoint is unofficial.** If it ever blocks requests, recall drops to sitemap-slug-matches plus their related-article expansion.
- **Body-only matches not in DDG's index** and not linked from any other in-range article will be missed.
- **Related-article expansion follows only one hop.** Articles two or more hops away are not reached.
- **rr.pt topic landing pages** (e.g. `/topico/sexualidade`) currently return 404 and cannot be used as seed lists.
- **Author extraction** depends on meta tags or a "Por <Name>" pattern; some older articles may have an empty author field.
- **Boolean grouping is flat OR-of-ANDs.** Parentheses and nested grouping are not supported. No proximity (`NEAR/n`) or per-field qualifiers (`title:cidadania`).
- **Phrase matching is substring-based** on normalised text, so very short phrases inside longer words are theoretically possible (mitigated by the 4-char minimum on stem variants).

---

## 12. End-to-end example

**Search**: query `"educação sexual" OR sexualidade NOT desporto`, range 19 Oct 2024 – 23 Nov 2024.

1. **Discovery (DDG)** — 2 OR-groups → 2 DDG queries (`site:rr.pt "educação sexual"` and `site:rr.pt sexualidade`). Returns ~20 unique rr.pt URLs.
2. **Discovery (sitemap)** — Sitemaps for 2024-10 and 2024-11 fetched; ~16,000 in-range URLs; slug filter keeps a handful containing `educacao-sexual` or `sexualidade` in the slug.
3. **Candidate building** — Merged + deduped + capped → ~25 candidates.
4. **Verification** — Each fetched, parsed, and tested. Articles containing "desporto" anywhere in body/description are rejected. ~15 confirmed matches survive.
5. **Related-article expansion** — Each match's `Saiba Mais` block contributes ~15–20 related URLs. After date and dedupe filters, ~80 remain. They are scraped and verified through the same matcher; a handful of additional matches are added.
6. **Final result** — ~15–25 articles, all inside the requested window, all satisfying the boolean query, sorted newest first.
