import { createServerFn } from "@tanstack/react-start";
import Firecrawl from "@mendable/firecrawl-js";

export type Article = {
  url: string;
  title: string;
  author: string;
  date: string;
  snippet: string;
};

export type SearchInput = {
  keywords: string[];
  startDate?: string;
  endDate?: string;
  limit?: number;
};

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

function validate(input: unknown): SearchInput {
  if (!input || typeof input !== "object") throw new Error("Invalid input");
  const i = input as Record<string, unknown>;
  const keywords = Array.isArray(i.keywords)
    ? (i.keywords as unknown[]).filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim()).slice(0, 10)
    : [];
  if (!keywords.length) throw new Error("Provide at least one keyword");
  const startDate = typeof i.startDate === "string" ? i.startDate : undefined;
  const endDate = typeof i.endDate === "string" ? i.endDate : undefined;
  const rawLimit = typeof i.limit === "number" ? i.limit : 20;
  const limit = Math.min(Math.max(rawLimit, 1), 40);
  return { keywords, startDate, endDate, limit };
}

export const searchArticles = createServerFn({ method: "POST" })
  .inputValidator(validate)
  .handler(async ({ data }): Promise<Article[]> => {
    const apiKey = process.env.FIRECRAWL_API_KEY;
    if (!apiKey) throw new Error("FIRECRAWL_API_KEY is not configured");

    const { keywords, startDate, endDate, limit } = data;
    const firecrawl = new Firecrawl({ apiKey });

    const orQuery = keywords.map((k) => (k.includes(" ") ? `"${k}"` : k)).join(" OR ");
    const query = `site:rr.pt (${orQuery})`;

    const searchRes = (await firecrawl.search(query, {
      limit,
    } as any)) as any;

    const rawResults: any[] =
      (searchRes?.web as any[]) ||
      (searchRes?.data as any[]) ||
      (Array.isArray(searchRes) ? searchRes : []) ||
      [];

    const urls: string[] = rawResults
      .map((r) => r.url || r.link)
      .filter((u: any) => typeof u === "string" && u.includes("rr.pt"));

    const articles: Article[] = [];

    await Promise.all(
      urls.map(async (url) => {
        try {
          const scraped: any = await firecrawl.scrape(url, {
            formats: ["markdown"],
            onlyMainContent: true,
          } as any);
          const markdown: string = scraped?.markdown || scraped?.data?.markdown || "";
          const meta: Record<string, any> =
            scraped?.metadata || scraped?.data?.metadata || {};

          if (!matchesKeywords(markdown, keywords)) return;
          const dateIso = extractDate(meta);
          if (!inDateRange(dateIso, startDate, endDate)) return;

          const title =
            pickMeta(meta, ["og:title", "title", "twitter:title"]) ||
            (markdown.match(/^#\s+(.+)$/m)?.[1] ?? "");
          const author = extractAuthor(meta, markdown);
          const snippet = markdown.replace(/\s+/g, " ").slice(0, 240);

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

    articles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return articles;
  });
