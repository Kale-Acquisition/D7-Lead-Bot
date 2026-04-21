import "dotenv/config";
import express from "express";
import path from "path";
import { JobQueue } from "./queue";
import { D7Scraper } from "./scrapers/d7";
import { D7BulkScraper } from "./scrapers/d7-bulk";
import { UniversalLead } from "./scrapers/types";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ── Setup ────────────────────────────────────────────────────────────────────

const queue = new JobQueue();

// Register D7 API scraper
const d7ApiKey = process.env.D7_API_KEY;
if (!d7ApiKey) {
  console.error("Error: D7_API_KEY is not set in .env");
  process.exit(1);
}
queue.registerScraper(new D7Scraper(d7ApiKey));

// Register D7 Bulk scraper (browser-based)
const d7Email = process.env.D7_EMAIL;
const d7Password = process.env.D7_PASSWORD;
if (d7Email && d7Password) {
  const headless = process.env.HEADLESS === "true";
  queue.registerScraper(new D7BulkScraper(d7Email, d7Password, headless));
  console.log("D7 Bulk Search (browser) scraper registered");
} else {
  console.log("Skipping D7 Bulk scraper — set D7_EMAIL and D7_PASSWORD in .env to enable it");
}

// ── API routes ───────────────────────────────────────────────────────────────

/** Queue status */
app.get("/api/queue/status", (_req, res) => {
  res.json(queue.getStatus());
});

/** Stop the queue (aborts current browser job immediately) */
app.post("/api/queue/stop", (_req, res) => {
  queue.stop();
  res.json({ ok: true });
});

/** Resume the queue */
app.post("/api/queue/resume", (_req, res) => {
  queue.resume();
  res.json({ ok: true });
});

/** Start manual login flow (opens visible browser for CAPTCHA) */
app.post("/api/auth/d7-bulk/start", (_req, res) => {
  const scraper = queue.getScraper("d7-bulk") as D7BulkScraper | undefined;
  if (!scraper) {
    res.status(404).json({ error: "Bulk scraper not registered — set D7_EMAIL and D7_PASSWORD in .env" });
    return;
  }
  // Fire-and-forget — browser opens, user solves CAPTCHA, session saved automatically
  scraper.loginManually().catch((err) => console.error("[auth]", err.message));
  res.json({ ok: true });
});

/** Get login status for bulk scraper */
app.get("/api/auth/d7-bulk/status", (_req, res) => {
  const scraper = queue.getScraper("d7-bulk") as D7BulkScraper | undefined;
  if (!scraper) { res.json({ state: "unavailable", hasSession: false }); return; }
  res.json(scraper.getLoginState());
});

/** List available scrapers */
app.get("/api/scrapers", (_req, res) => {
  res.json(queue.listScrapers());
});

/** Submit new jobs: { keywords: string[], locations: string[], country?: string, scraperId?: string } */
app.post("/api/jobs", (req, res) => {
  const { keywords, locations, country = "US", scraperId = "d7" } = req.body as {
    keywords?: string[];
    locations?: string[];
    country?: string;
    scraperId?: string;
  };

  if (!Array.isArray(keywords) || keywords.length === 0) {
    res.status(400).json({ error: "keywords must be a non-empty array" });
    return;
  }
  if (!Array.isArray(locations) || locations.length === 0) {
    res.status(400).json({ error: "locations must be a non-empty array" });
    return;
  }

  const jobs = queue.enqueue(keywords, locations, country, scraperId);
  res.json(jobs);
});

/** Get all jobs (with status) */
app.get("/api/jobs", (_req, res) => {
  // Strip large results array from list view — just send counts
  const jobs = queue.getAllJobs().map(({ results: _r, ...job }) => job);
  res.json(jobs);
});

/** Get a single job (includes full results) */
app.get("/api/jobs/:id", (req, res) => {
  const job = queue.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

/** Clear completed/failed jobs */
app.delete("/api/jobs/completed", (_req, res) => {
  queue.clearCompleted();
  res.json({ ok: true });
});

/** Clear ALL jobs */
app.delete("/api/jobs", (_req, res) => {
  queue.clearAll();
  res.json({ ok: true });
});

/** Get all aggregated results */
app.get("/api/results", (_req, res) => {
  res.json(queue.getAllResults());
});

/** Download all results as CSV */
app.get("/api/results/csv", (_req, res) => {
  const results = queue.getAllResults();
  if (!results.length) {
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
    res.send("");
    return;
  }

  // Collect every column that appears across all results (preserving first-seen order)
  const colSet = new Map<string, true>();
  for (const lead of results) {
    for (const key of Object.keys(lead)) colSet.set(key, true);
  }
  const cols = Array.from(colSet.keys());

  const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const lines = [
    cols.map(escape).join(","),
    ...results.map((lead) => cols.map((c) => escape(lead[c] ?? "")).join(",")),
  ];

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="leads.csv"');
  res.send(lines.join("\n") + "\n");
});

/** Get account info for a scraper */
app.get("/api/account/:scraperId", async (req, res) => {
  const scraper = queue.getScraper(req.params.scraperId);
  if (!scraper) {
    res.status(404).json({ error: "Scraper not found" });
    return;
  }
  if (!scraper.getAccount) {
    res.status(404).json({ error: "This scraper does not support account info" });
    return;
  }
  try {
    res.json(await scraper.getAccount());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`\nD7 Bot running → http://localhost:${PORT}\n`);
});
