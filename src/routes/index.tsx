import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { format } from "date-fns";
import { CalendarIcon, Download, Loader2, Search, Newspaper } from "lucide-react";
import ExcelJS from "exceljs";

import { searchArticles, type Article } from "@/server/searchArticles";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "rr.pt Article Scraper — Search & Export to Excel" },
      {
        name: "description",
        content:
          "Search articles on rr.pt by full-text keywords and date range, then export results to Excel.",
      },
      { property: "og:title", content: "rr.pt Article Scraper" },
      {
        property: "og:description",
        content: "Full-text keyword search on rr.pt with Excel export.",
      },
    ],
  }),
  component: Index,
});
function DatePick({
  date,
  setDate,
  placeholder,
}: {
  date?: Date;
  setDate: (d?: Date) => void;
  placeholder: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
          )}
        >
          <CalendarIcon className="mr-2 h-4 w-4" />
          {date ? format(date, "PPP") : <span>{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={date}
          onSelect={setDate}
          initialFocus
          className={cn("p-3 pointer-events-auto")}
        />
      </PopoverContent>
    </Popover>
  );
}

function Index() {
  const [keywordsInput, setKeywordsInput] = useState("");
  const [startDate, setStartDate] = useState<Date | undefined>();
  const [endDate, setEndDate] = useState<Date | undefined>();
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    const keywords = keywordsInput
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keywords.length) {
      toast.error("Enter at least one keyword");
      return;
    }
    setLoading(true);
    setSearched(true);
    try {
      const result = await searchArticles({
        data: {
          keywords,
          startDate: startDate ? format(startDate, "yyyy-MM-dd") : undefined,
          endDate: endDate ? format(endDate, "yyyy-MM-dd") : undefined,
          limit,
        },
      });
      setArticles(result);
      toast.success(`Found ${result.length} matching article(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
      setArticles([]);
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    if (!articles.length) return;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("rr.pt articles");
    ws.columns = [
      { header: "URL", key: "url", width: 60 },
      { header: "Title", key: "title", width: 60 },
      { header: "Author", key: "author", width: 28 },
      { header: "Date", key: "date", width: 22 },
    ];
    ws.getRow(1).font = { bold: true };
    articles.forEach((a) => {
      ws.addRow({
        url: a.url,
        title: a.title,
        author: a.author,
        date: a.date ? format(new Date(a.date), "yyyy-MM-dd HH:mm") : "",
      });
    });
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `rrpt-articles-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <Toaster />
      <div className="container mx-auto max-w-6xl px-4 py-10">
        <header className="mb-8 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Newspaper className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight md:text-3xl">
              rr.pt Article Scraper
            </h1>
            <p className="text-sm text-muted-foreground">
              Full-text keyword search · date range · Excel export
            </p>
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Search</CardTitle>
            <CardDescription>
              Comma-separated keywords (matches any). Searches rr.pt and filters
              by article body + publication date.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="kw">Keywords</Label>
              <Input
                id="kw"
                placeholder="e.g. inflação, governo, Lisboa"
                value={keywordsInput}
                onChange={(e) => setKeywordsInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              />
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Start date</Label>
                <DatePick
                  date={startDate}
                  setDate={setStartDate}
                  placeholder="Any"
                />
              </div>
              <div className="space-y-2">
                <Label>End date</Label>
                <DatePick
                  date={endDate}
                  setDate={setEndDate}
                  placeholder="Any"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="limit">Max results to scan</Label>
                <Input
                  id="limit"
                  type="number"
                  min={1}
                  max={40}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value) || 20)}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button onClick={handleSearch} disabled={loading}>
                {loading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Search className="mr-2 h-4 w-4" />
                )}
                Search
              </Button>
              <Button
                variant="secondary"
                onClick={handleExport}
                disabled={!articles.length}
              >
                <Download className="mr-2 h-4 w-4" />
                Export Excel
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>
              Results {articles.length > 0 && `(${articles.length})`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                Searching and scraping rr.pt…
              </div>
            ) : articles.length ? (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[40%]">Title</TableHead>
                      <TableHead>Author</TableHead>
                      <TableHead>Date</TableHead>
                      <TableHead>Link</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {articles.map((a) => (
                      <TableRow key={a.url}>
                        <TableCell className="font-medium">
                          {a.title || "(untitled)"}
                        </TableCell>
                        <TableCell>{a.author || "—"}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {a.date
                            ? format(new Date(a.date), "yyyy-MM-dd")
                            : "—"}
                        </TableCell>
                        <TableCell>
                          <a
                            href={a.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-primary underline-offset-2 hover:underline"
                          >
                            Open
                          </a>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                {searched
                  ? "No articles matched. Try different keywords or widen the date range."
                  : "Enter keywords above to start."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
