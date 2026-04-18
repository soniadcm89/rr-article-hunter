import { createServerFn } from "@tanstack/react-start";
import Firecrawl from "@mendable/firecrawl-js";

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
  "Mozilla/5.0 (compatible; LovableBot/1.0; +https://lovable.dev)";

/* ----------------------------- helpers ------------------------------ */

function pickMeta(meta: Record<string, any> | undefined, keys: string[]): string {
  if (!meta) return "";
  for (const k of keys) {
    const v = meta[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.length && typeof v[0] === "string") return v[0];
  }
  return "";
}

function extractAuthor(meta: Record<string, any> | undefined, markdown: string): string {
  const m = pickMeta(meta, [
    "author",
    "article:author",
    "og:article:author",
    "byl",
    "dc.creator",
    "dcterms.creator",
    "twitter:creator",
  ]);
  if (m) return m.replace(/^https?:\/\/\S+\/?/, "").replace(/^@/, "");
  const byline = markdown
    .slice(0, 2000)
    .match(/(?:^|\n)\s*Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'.\- ]{2,80})/);
  return byline ? byline[1].trim() : "";
}

function extractDate(
  meta: Record<string, any> | undefined,
  fallbackUrlDate?: string,
): string {
  const d = pickMeta(meta, [
    "article:published_time",
    "og:article:published_time",
    "datePublished",
    "publishdate",
    "pubdate",
    "date",
    "dc.date",
    "dcterms.created",
    "article:modified_time",
  ]);
  if (d) {
    const parsed = new Date(d);
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return fallbackUrlDate ?? "";
}

/** Normalize text for keyword matching — lowercase + strip diacritics. */
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

/** Extract YYYY/MM/DD from rr.pt article URL. Returns ISO date or "". */
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

/** Build list of YYYY-MM month tags between two dates inclusive. */
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

async function fetchSitemapIndex(): Promise<string[]> {
  const res = await fetch("https://rr.pt/sitemapindex.xml", {
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`sitemap index ${res.status}`);
  const xml = await res.text();
  return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g)).map((m) => m[1]);
}

async function fetchSitemapUrls(sitemapUrl: string): Promise<string[]> {
  try {
    const res = await fetch(sitemapUrl, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const xml = await res.text();
    return Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
      .map((m) => m[1])
      .filter((u) => u.includes("rr.pt") && /\/\d{4}\/\d{2}\/\d{2}\//.test(u));
  } catch {
    return [];
  }
}

/** Decode the article slug to readable text for cheap keyword pre-filter. */
function slugTextFromUrl(url: string): string {
  // pattern: /noticia/<section>/YYYY/MM/DD/<slug>/<id>/
  const m = url.match(/\/(\d{4})\/(\d{2})\/(\d{2})\/([^/]+)\/(\d+)\//);
  if (!m) return url;
  return m[4].replace(/-/g, " ");
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
  const rawMax = typeof i.maxScrapes === "number" ? i.maxScrapes : 60;
  const maxScrapes = Math.min(Math.max(rawMax, 5), 200);
  return { keywords, startDate, endDate, maxScrapes };
}

export const searchArticles = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<{ articles: Article[]; stats: any }> => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

    const { keywords, startDate, endDate, maxScrapes } = data;
    const normKeywords = keywords.map(normalize).filter(Boolean);
    const firecrawl = new Firecrawl({ apiKey });

    /* ---------- 1. Discover candidate URLs from monthly sitemaps ---------- */

    // Default range: last 6 months if no start date.
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

    // Filter URLs by date range (using URL date parts).
    const inRangeUrls = allUrls.filter((u) =>
      inDateRange(dateFromUrl(u), startDate, endDate),
    );

    /* ---------- 2. Cheap pre-filter by slug match ---------- */

    const slugMatches = inRangeUrls.filter((u) => {
      const slug = normalize(slugTextFromUrl(u));
      return normKeywords.some((k) => slug.includes(k));
    });

    /* ---------- 3. Also pull Firecrawl search hits per keyword ---------- */

    const firecrawlUrls = new Set<string>();
    await Promise.all(
      keywords.map(async (kw) => {
        try {
          const q = `site:rr.pt ${kw.includes(" ") ? `"${kw}"` : kw}`;
          const res: any = await firecrawl.search(q, { limit: 20 } as any);
          const raw: any[] =
            (res?.web as any[]) ||
            (res?.data as any[]) ||
            (Array.isArray(res) ? res : []) ||
            [];
          for (const r of raw) {
            const u = r.url || r.link;
            if (
              typeof u === "string" &&
              u.includes("rr.pt") &&
              /\/\d{4}\/\d{2}\/\d{2}\//.test(u) &&
              inDateRange(dateFromUrl(u), startDate, endDate)
            ) {
              firecrawlUrls.add(u);
            }
          }
        } catch (err) {
          console.error("firecrawl search failed for", kw, err);
        }
      }),
    );

    /* ---------- 4. Build final candidate set ---------- */

    // Slug matches first (most likely to be relevant), then firecrawl hits,
    // then a sample from the rest of the date-range pool to catch articles
    // whose slug doesn't contain the keyword.
    const candidateOrder: string[] = [];
    const seen = new Set<string>();
    const push = (u: string) => {
      if (!seen.has(u)) {
        seen.add(u);
        candidateOrder.push(u);
      }
    };
    slugMatches.forEach(push);
    firecrawlUrls.forEach(push);

    // Cap candidates to scrape budget. Slug + firecrawl already prioritized;
    // we don't randomly add the rest — would blow scrape budget on noise.
    const toScrape = candidateOrder.slice(0, maxScrapes);

    /* ---------- 5. Scrape and match ---------- */

    const articles: Article[] = [];
    const concurrency = 8;
    let cursor = 0;

    async function worker() {
      while (cursor < toScrape.length) {
        const i = cursor++;
        const url = toScrape[i];
        try {
          const scraped: any = await firecrawl.scrape(url, {
            formats: ["markdown"],
            onlyMainContent: true,
          } as any);
          const markdown: string =
            scraped?.markdown || scraped?.data?.markdown || "";
          const meta: Record<string, any> =
            scraped?.metadata || scraped?.data?.metadata || {};

          const title =
            pickMeta(meta, ["og:title", "title", "twitter:title"]) ||
            (markdown.match(/^#\s+(.+)$/m)?.[1] ?? "");
          const description = pickMeta(meta, [
            "description",
            "og:description",
            "twitter:description",
          ]);

          // Combine all searchable surfaces.
          const slugText = slugTextFromUrl(url);
          const haystacks: { name: string; text: string }[] = [
            { name: "title", text: title },
            { name: "description", text: description },
            { name: "url", text: slugText },
            { name: "body", text: markdown },
          ];

          const matchedIn: string[] = [];
          for (const h of haystacks) {
            if (matchKeywords(h.text, normKeywords).length) matchedIn.push(h.name);
          }
          if (!matchedIn.length) continue;

          const dateIso = extractDate(meta, dateFromUrl(url));
          if (!inDateRange(dateIso, startDate, endDate)) continue;

          articles.push({
            url,
            title: title.trim(),
            author: extractAuthor(meta, markdown),
            date: dateIso,
            snippet: (description || markdown).replace(/\s+/g, " ").slice(0, 240),
            matchedIn: matchedIn.join(", "),
          });
        } catch (err) {
          console.error("scrape failed", url, err);
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
        firecrawlHits: firecrawlUrls.size,
        candidatesScraped: toScrape.length,
        matched: articles.length,
      },
    };
  });
