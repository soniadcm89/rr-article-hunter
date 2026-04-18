import { createFileRoute } from "@tanstack/react-router";
import Firecrawl from "@mendable/firecrawl-js";

type SearchBody = {
  keywords: string[];
  startDate?: string; // ISO yyyy-mm-dd
  endDate?: string;
  limit?: number;
};

type Article = {
  url: string;
  title: string;
  author: string;
  date: string;
  snippet: string;
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

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
  // Fallback: look for "Por <Name>" early in markdown (Portuguese byline)
  const byline = markdown.slice(0, 2000).match(/(?:^|\n)\s*Por\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ][\wÁÉÍÓÚÂÊÔÃÕÇáéíóúâêôãõç'.\- ]{2,80})/);
  return byline ? byline[1].trim() : "";
}

function extractDate(meta: Record<string, any> | undefined): string {
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
  if (!d) return "";
  const parsed = new Date(d);
  return isNaN(parsed.getTime()) ? d : parsed.toISOString();
}

function matchesKeywords(text: string, keywords: string[]): boolean {
  const hay = text.toLowerCase();
  return keywords.some((k) => k && hay.includes(k.toLowerCase()));
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

async function handleSearch(body: SearchBody) {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

  const keywords = (body.keywords || []).map((k) => k.trim()).filter(Boolean);
  if (!keywords.length) throw new Error("Provide at least one keyword");
  const limit = Math.min(Math.max(body.limit ?? 20, 1), 40);

  const firecrawl = new Firecrawl({ apiKey });

  // Build a query that targets rr.pt and OR-joins keywords
  const orQuery = keywords.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
  const query = `site:rr.pt (${orQuery})`;

  const searchRes: any = await firecrawl.search(query, {
    limit,
    lang: "pt",
    country: "pt",
  });

  const rawResults: any[] =
    (searchRes?.web as any[]) ||
    (searchRes?.data as any[]) ||
    (Array.isArray(searchRes) ? searchRes : []) ||
    [];

  const urls = rawResults
    .map((r) => r.url || r.link)
    .filter((u: string) => typeof u === "string" && u.includes("rr.pt"));

  const articles: Article[] = [];

  // Scrape each result, filter by full-text keyword + date range
  await Promise.all(
    urls.map(async (url) => {
      try {
        const scraped: any = await firecrawl.scrape(url, {
          formats: ["markdown"],
          onlyMainContent: true,
        });
        const markdown: string =
          scraped?.markdown || scraped?.data?.markdown || "";
        const meta: Record<string, any> =
          scraped?.metadata || scraped?.data?.metadata || {};

        if (!matchesKeywords(markdown, keywords)) return;

        const dateIso = extractDate(meta);
        if (!inDateRange(dateIso, body.startDate, body.endDate)) return;

        const title =
          pickMeta(meta, ["og:title", "title", "twitter:title"]) ||
          (markdown.match(/^#\s+(.+)$/m)?.[1] ?? "");

        const author = extractAuthor(meta, markdown);

        const snippet = markdown
          .replace(/\s+/g, " ")
          .slice(0, 240);

        articles.push({
          url,
          title: title.trim(),
          author,
          date: dateIso,
          snippet,
        });
      } catch (err) {
        console.error("scrape failed", url, err);
      }
    }),
  );

  // Sort newest first
  articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return articles;
}

export const Route = createFileRoute("/api/search")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS }),
      POST: async ({ request }) => {
        try {
          const body = (await request.json()) as SearchBody;
          const articles = await handleSearch(body);
          return json({ success: true, articles });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error";
          return json({ success: false, error: msg }, 500);
        }
      },
    },
  },
});
