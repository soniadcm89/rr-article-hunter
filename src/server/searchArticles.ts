import { createServerFn } from "@tanstack/react-start";

export type Article = {
  url: string;
  title: string;
  author: string;
  date: string;
  snippet: string;
  matchedIn: string;
};

export type SearchInput = {
  keywords: string[];
  startDate?: string;
  endDate?: string;
  maxScrapes?: number;
};

const UA =
  "Mozilla/5.0 (compatible; LovableBot/1.0; +https://lovable.dev) AppleWebKit/537.36";

/* ----------------------------- helpers ------------------------------ */

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function matchKeywords(text: string, normKeywords: string[]): string[] {
  const hay = normalize(text);
  return normKeywords.filter((k) => k && hay.includes(k));
}

function expandKeyword(raw: string): string[] {
  const base = normalize(raw.trim());
  const variants = new Set<string>([base]);

  // RR/manual search often treats Portuguese abstract nouns broadly.
  // Example: searching "sexualidade" should also find "educação sexual",
  // "violência sexual", etc., which are otherwise missed by exact matching.
  if (base.endsWith("idades") && base.length > 9) {
    variants.add(base.slice(0, -6));
  } else if (base.endsWith("idade") && base.length > 8) {
    variants.add(base.slice(0, -5));
  }

  return Array.from(variants).filter((k) => k.length >= 4);
}

function parseDateOnly(dateStr: string): Date | null {
  if (!dateStr) return null;

  const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const result = new Date(Date.UTC(+iso[1], +iso[2] - 1, +iso[3]));
    if (result.getUTCDate() !== +iso[3] || result.getUTCMonth() !== +iso[2] - 1) return null;
    return result;
  }

  const dmy = dateStr.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (dmy) {
    const day = +dmy[1];
    const month = +dmy[2];
    const year = +dmy[3] < 100 ? +dmy[3] + 2000 : +dmy[3];
    const result = new Date(Date.UTC(year, month - 1, day));
    if (result.getUTCDate() !== day || result.getUTCMonth() !== month - 1) return null;
    return result;
  }

  return null;
}

function dateFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
}

function inDateRange(iso: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!iso) return false;
  const articleDate = parseDateOnly(iso);
  if (!articleDate) return false;
  const t = articleDate.getTime();
  const startDate = start ? parseDateOnly(start) : null;
  const endDate = end ? parseDateOnly(end) : null;
  if (startDate && t < startDate.getTime()) return false;
  if (endDate && t > endDate.getTime()) return false;
  return true;
}

function monthsBetween(start: Date, end: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const stop = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur.getTime() <= stop.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    out.push(`${y}-${m}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

async function fetchText(url: string, extraHeaders?: Record<string, string>): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
      ...(extraHeaders || {}),
    },
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

async function fetchSitemapIndex(): Promise<string[]> {
  const xml = await fetchText("https://rr.pt/sitemapindex.xml");
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
}

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    const xml = await fetchText(sitemapUrl);
    return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
      .map((m) => m[1])
      .filter((u) => u.includes("rr.pt") && /\/\d{4}\/\d{2}\/\d{2}\//.test(u));
  } catch {
    return [];
  }
}

function slugTextFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/(\d+)\//);
  if (!m) return url;
  return m[4].replace(/-/g, " ");
}

/* ------------------------- DuckDuckGo search ------------------------ */

function decodeDdgUrl(href: string): string | null {
  // DDG wraps results as //duckduckgo.com/l/?uddg=<encoded>&...
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return null;
    }
  }
  if (href.startsWith("http")) return href;
  if (href.startsWith("//")) return "https:" + href;
  return null;
}

async function ddgSearch(keyword: string, maxPages = 5): Promise<string[]> {
  const found = new Set<string>();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * 30;
    const q = encodeURIComponent(`site:rr.pt ${keyword}`);
    const url =
      page === 0
        ? `https://html.duckduckgo.com/html/?q=${q}`
        : `https://html.duckduckgo.com/html/?q=${q}&s=${offset}&dc=${offset + 1}`;
    let html: string;
    try {
      html = await fetchText(url, { Referer: "https://html.duckduckgo.com/" });
    } catch (err) {
      console.error("ddg fetch failed", url, err);
      break;
    }
    const before = found.size;
    const hrefs = Array.from(html.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
    for (const h of hrefs) {
      const decoded = decodeDdgUrl(h);
      if (!decoded) continue;
      if (!/^https?:\/\/(www\.)?rr\.pt\//.test(decoded)) continue;
      // only article URLs (have a date segment)
      if (!/\/\d{4}\/\d{2}\/\d{2}\//.test(decoded)) continue;
      // strip query/hash
      const clean = decoded.split("#")[0].split("?")[0];
      found.add(clean);
    }
    // if no new results, stop paginating
    if (found.size === before) break;
    // small delay between pages
    await new Promise((r) => setTimeout(r, 250));
  }
  return Array.from(found);
}

/* ----------------------- HTML parsing helpers ----------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  ).replace(/\s+/g, " ").trim();
}

function getMeta(html: string, attr: "name" | "property", value: string): string {
  const re = new RegExp(
    `<meta[^>]*${attr}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  if (m) return decodeEntities(m[1]).trim();
  const re2 = new RegExp(
    `<meta[^>]*content=["']([^"']*)["'][^>]*${attr}=["']${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`,
    "i",
  );
  const m2 = html.match(re2);
  return m2 ? decodeEntities(m2[1]).trim() : "";
}

function getTitle(html: string): string {
  return (
    getMeta(html, "property", "og:title") ||
    getMeta(html, "name", "twitter:title") ||
    (html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim()
      ? decodeEntities(html.match(/<title>([^<]*)<\/title>/i)![1]).trim()
      : "")
  );
}

function getDescription(html: string): string {
  return (
    getMeta(html, "property", "og:description") ||
    getMeta(html, "name", "description") ||
    getMeta(html, "name", "twitter:description")
  );
}

function getAuthor(html: string, bodyText: string): string {
  const m =
    getMeta(html, "name", "author") ||
    getMeta(html, "property", "article:author") ||
    getMeta(html, "name", "dc.creator");
  if (m) return m.replace(/^https?:\/\/\S+\/?/, "").replace(/^@/, "");
  const byline = bodyText
    .slice(0, 2000)
    .match(/\bPor\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'.\- ]{2,80})/);
  return byline ? byline[1].trim() : "";
}

function getPublishDate(html: string, urlFallback: string): string {
  const candidates = [
    getMeta(html, "property", "article:published_time"),
    getMeta(html, "property", "og:article:published_time"),
    getMeta(html, "name", "pubdate"),
    getMeta(html, "name", "publishdate"),
    getMeta(html, "name", "date"),
    getMeta(html, "name", "dc.date"),
    getMeta(html, "property", "article:modified_time"),
  ];
  for (const c of candidates) {
    if (c) {
      const d = new Date(c);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
  }
  const tm = html.match(/<time[^>]*datetime=["']([^"']+)["']/i);
  if (tm) {
    const d = new Date(tm[1]);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return urlFallback;
}

/* ----------------------------- main ------------------------------- */

function validate(input: unknown): SearchInput {
  if (!input || typeof input !== "object") throw new Error("Invalid input");
  const i = input as Record<string, unknown>;
  const keywords = Array.isArray(i.keywords)
    ? (i.keywords as unknown[])
        .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
        .map((k) => k.trim())
        .slice(0, 10)
    : [];
  if (!keywords.length) throw new Error("Provide at least one keyword");
  const startDate = typeof i.startDate === "string" ? i.startDate : undefined;
  const endDate = typeof i.endDate === "string" ? i.endDate : undefined;
  const rawMax = typeof i.maxScrapes === "number" ? i.maxScrapes : 200;
  const maxScrapes = Math.min(Math.max(rawMax, 5), 500);
  return { keywords, startDate, endDate, maxScrapes };
}

export const searchArticles = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<{ articles: Article[]; stats: any }> => {
    const { keywords, startDate, endDate, maxScrapes } = data;
    const normKeywords = Array.from(new Set(keywords.flatMap(expandKeyword)));

    /* 1. Discover URLs from DuckDuckGo (full-text) per keyword */
    const ddgResults = await Promise.all(
      normKeywords.map((k) => ddgSearch(k).catch((err) => {
        console.error("ddgSearch failed for", k, err);
        return [] as string[];
      })),
    );
    const ddgUrls = Array.from(new Set(ddgResults.flat()));
    const ddgInRange = ddgUrls.filter((u) =>
      inDateRange(dateFromUrl(u), startDate, endDate),
    );

    /* 2. Sitemap supplement — slug matches in date range */
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));

    const wantedMonths = new Set(monthsBetween(start, end));
    let targetSitemaps: string[] = [];
    let inRangeUrls: string[] = [];
    let slugMatches: string[] = [];
    try {
      const allSitemaps = await fetchSitemapIndex();
      targetSitemaps = allSitemaps.filter((u) => {
        const m = u.match(/sitemap-(\d{4}-\d{2})\.xml$/);
        return m ? wantedMonths.has(m[1]) : false;
      });
      const sitemapResults = await Promise.all(targetSitemaps.map(fetchSitemapUrls));
      const allUrls = Array.from(new Set(sitemapResults.flat()));
      inRangeUrls = allUrls.filter((u) =>
        inDateRange(dateFromUrl(u), startDate, endDate),
      );
      slugMatches = inRangeUrls.filter((u) => {
        const slug = normalize(slugTextFromUrl(u));
        return normKeywords.some((k) => slug.includes(k));
      });
    } catch (err) {
      console.error("sitemap fetch failed", err);
    }

    /* 3. Build candidate list — DDG hits first, then sitemap slug matches */
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (u: string) => {
      if (!seen.has(u)) {
        seen.add(u);
        candidates.push(u);
      }
    };
    ddgInRange.forEach(push);
    slugMatches.forEach(push);
    const toScrape = candidates.slice(0, maxScrapes);

    /* 4. Fetch each article HTML and verify match */
    const articles: Article[] = [];
    const concurrency = 10;
    let cursor = 0;
    let fetchErrors = 0;

    async function worker() {
      while (cursor < toScrape.length) {
        const i = cursor++;
        const url = toScrape[i];
        try {
          const html = await fetchText(url);
          const title = getTitle(html);
          const description = getDescription(html);
          const bodyText = stripTags(html);
          const slugText = slugTextFromUrl(url);

          const haystacks = [
            { name: "title", text: title },
            { name: "description", text: description },
            { name: "url", text: slugText },
            { name: "body", text: bodyText },
          ];
          const matchedIn: string[] = [];
          for (const h of haystacks) {
            if (matchKeywords(h.text, normKeywords).length) matchedIn.push(h.name);
          }
          if (!matchedIn.length) continue;

          const dateIso = getPublishDate(html, dateFromUrl(url));
          if (!inDateRange(dateIso, startDate, endDate)) continue;

          articles.push({
            url,
            title: title.trim(),
            author: getAuthor(html, bodyText),
            date: dateIso,
            snippet: (description || bodyText).replace(/\s+/g, " ").slice(0, 240),
            matchedIn: matchedIn.join(", "),
          });
        } catch (err) {
          fetchErrors++;
          console.error("fetch failed", url, err);
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    return {
      articles,
      stats: {
        sitemapsScanned: targetSitemaps.length,
        urlsInRange: inRangeUrls.length,
        slugMatches: slugMatches.length,
        ddgHits: ddgInRange.length,
        candidatesScraped: toScrape.length,
        matched: articles.length,
        fetchErrors,
      },
    };
  });
