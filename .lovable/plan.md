# Composed keywords + boolean operators

## Goal
Let users type natural multi-word queries (`aulas de cidadania`), exact phrases (`"educação sexual"`), and boolean expressions (`cidadania AND escola`, `cidadania OR civismo`, `cidadania NOT desenvolvimento`) — without breaking single-keyword behavior or making runs dramatically slower.

## Query language

| Syntax | Behavior |
|---|---|
| `cidadania` | Single term (today's behavior, unchanged) |
| `aulas de cidadania` | **Treated as exact phrase by default** — fast, precise, mirrors how Google site-search and RR's own search behave |
| `"aulas de cidadania"` | Explicit exact phrase (same as above; quotes optional but supported) |
| `A AND B` | Both terms must appear anywhere in the article |
| `A OR B` | Either term qualifies |
| `A NOT B` | A required, B forbidden |
| Mixed: `"educação sexual" OR cidadania NOT autárquicas` | Combined |

Stopwords (`de`, `da`, `do`, `e`, `a`, `o`, `em`, `na`, `no`) are ignored only inside explicit `AND` clauses, never inside phrases.

Limit: max **4 OR clauses** per query to bound DDG calls.

## How it works end-to-end

```text
user input
   │
   ▼
parseQuery()  ──►  { phrases: [...], andTerms: [...], orGroups: [[...]], notTerms: [...] }
   │
   ├── Discovery (DDG): one query per OR-group, phrases auto-quoted
   ├── Discovery (sitemap): slug pre-filter using phrase OR andTerm
   │
   ▼
Candidate URLs (deduped, in date range)
   │
   ▼
Scrape + verify: matchQuery(text) returns true only if
   ALL phrases present AND ALL andTerms present AND
   at least one term from each orGroup present AND no notTerms present
   │
   ▼
Saiba Mais 1-hop expansion (same matcher applied)
```

## Changes

### `src/server/searchArticles.ts`

1. **New `parseQuery(raw: string): ParsedQuery`**
   - Tokenizes respecting `"…"`, `AND`, `OR`, `NOT` (case-insensitive).
   - Default join is AND between bare tokens; multi-word bare input with no operators becomes a single phrase.
   - Strips Portuguese stopwords from AND clauses only.
   - Returns `{ phrases, andTerms, orGroups, notTerms, ddgQueries }`.

2. **Replace `expandKeyword` usage** with `parseQuery` for each user-entered keyword. Keep the `-idade(s)` stem expansion but apply it only to single bare terms, never to phrases.

3. **New `matchQuery(text, parsed): { matched: boolean, hits: string[] }`**
   - Replaces the current `matchKeywords`. Used in all four haystacks (title, description, slug, body).
   - Returns which clauses matched for the `matchedIn` field.

4. **DDG discovery**
   - Build one DDG query per OR-group: phrases quoted, AND terms space-joined.
   - Cap at 4 queries total; run in parallel as today.

5. **Sitemap slug pre-filter**
   - Pass if slug contains any phrase **or** all andTerms (stopwords excluded) **or** any orGroup term.
   - When the query has no usable slug-friendly token (e.g. only stopwords), fall back to "all in-range URLs" but cap at `maxScrapes`.

6. **Verification & Saiba Mais expansion**
   - Reuse `matchQuery` in both passes — no other logic change.
   - `notTerms` cause rejection in the body/description haystack only (not slug/title alone).

7. **Stats**
   - Add `parsedQuery` summary (phrases/and/or/not counts) to response for UI display and debugging.

### `src/routes/index.tsx`

- Update the keyword input helper text: *"Use quotes for exact phrases. Operators: AND, OR, NOT. Multi-word input is treated as a phrase."*
- Show parsed-query chip row under the input (e.g. `phrase: "aulas de cidadania"`, `OR: civismo`) so users see how their input was interpreted.
- No change to `maxScrapes` field.

## Performance impact (recap from previous answer)

- Single-word queries: **unchanged**.
- Default phrase queries (`aulas de cidadania`): **same speed as today**, better precision.
- Explicit AND across common words: ~2× scrape volume; mitigated by stopword stripping and slug pre-filter.
- OR queries: linear in number of OR clauses, capped at 4.
- Saiba Mais 1-hop expansion: unchanged, benefits more from richer queries.

## Out of scope
- Parentheses / nested boolean grouping (flat OR-of-ANDs only).
- Proximity operators (`NEAR/n`).
- Per-field qualifiers (`title:cidadania`).

## Expected outcome
- `aulas de cidadania` returns articles where that exact phrase appears (fast, precise).
- `cidadania AND escola` returns articles mentioning both, anywhere.
- `"educação sexual" OR sexualidade NOT desporto` works as written.
- Single-keyword runs perform identically to today.
