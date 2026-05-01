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

function dateFromUrl(url: string): string {
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\//);
  if (!m) return "";
  return `${m[1]}-${m[2]}-${m[3]}T00:00:00Z`;
}

function inDateRange(iso: string, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return false;
  if (start && t < new Date(start + "T00:00:00Z").getTime()) return false;
  if (end && t > new Date(end + "T23:59:59Z").getTime()) return false;
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

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
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
  // try reverse order content-first
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
  // look for byline pattern in first part of body
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
  // <time datetime="...">
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
  const rawMax = typeof i.maxScrapes === "number" ? i.maxScrapes : 80;
  const maxScrapes = Math.min(Math.max(rawMax, 5), 500);
  return { keywords, startDate, endDate, maxScrapes };
}

export const searchArticles = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<{ articles: Article[]; stats: any }> => {
    const { keywords, startDate, endDate, maxScrapes } = data;
    const normKeywords = keywords.map(normalize).filter(Boolean);

    /* 1. Discover URLs from monthly sitemaps */
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));

    const wantedMonths = new Set(monthsBetween(start, end));
    const allSitemaps = await fetchSitemapIndex();
    const targetSitemaps = allSitemaps.filter((u) => {
      const m = u.match(/sitemap-(\d{4}-\d{2})\.xml$/);
      return m ? wantedMonths.has(m[1]) : false;
    });

    const sitemapResults = await Promise.all(targetSitemaps.map(fetchSitemapUrls));
    const allUrls = Array.from(new Set(sitemapResults.flat()));
    const inRangeUrls = allUrls.filter((u) =>
      inDateRange(dateFromUrl(u), startDate, endDate),
    );

    /* 2. Slug pre-filter */
    const slugMatches = inRangeUrls.filter((u) => {
      const slug = normalize(slugTextFromUrl(u));
      return normKeywords.some((k) => slug.includes(k));
    });
    const slugMatchSet = new Set(slugMatches);
    const others = inRangeUrls.filter((u) => !slugMatchSet.has(u));

    /* 3. Build candidate list — slug matches first, then sample others up to budget */
    const candidates: string[] = [];
    const seen = new Set<string>();
    const push = (u: string) => {
      if (!seen.has(u)) {
        seen.add(u);
        candidates.push(u);
      }
    };
    slugMatches.forEach(push);
    others.forEach(push);
    const toScrape = candidates.slice(0, maxScrapes);

    /* 4. Fetch each article HTML and match */
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
        firecrawlHits: 0,
        candidatesScraped: toScrape.length,
        matched: articles.length,
        fetchErrors,
      },
    };
  });
