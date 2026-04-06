import { randomUUID } from "crypto";
import { IScraper, SearchJob, UniversalLead } from "./scrapers/types";

export class JobQueue {
  private jobs: Map<string, SearchJob> = new Map();
  private pending: string[] = []; // job IDs waiting to run
  private processing = false;
  private scrapers: Map<string, IScraper> = new Map();

  // ── Scraper registry ─────────────────────────────────────────────────────

  registerScraper(scraper: IScraper): void {
    this.scrapers.set(scraper.id, scraper);
  }

  getScraper(id: string): IScraper | undefined {
    return this.scrapers.get(id);
  }

  listScrapers(): Array<{ id: string; name: string }> {
    return Array.from(this.scrapers.values()).map((s) => ({ id: s.id, name: s.name }));
  }

  // ── Job management ───────────────────────────────────────────────────────

  /**
   * Create one job per (keyword × location) combination and enqueue them.
   */
  enqueue(
    keywords: string[],
    locations: string[],
    country: string,
    scraperId: string
  ): SearchJob[] {
    const created: SearchJob[] = [];

    for (const keyword of keywords) {
      for (const location of locations) {
        const job: SearchJob = {
          id: randomUUID(),
          keyword,
          location,
          country,
          scraperId,
          status: "queued",
          results: [],
          resultCount: 0,
          createdAt: Date.now(),
        };
        this.jobs.set(job.id, job);
        this.pending.push(job.id);
        created.push(job);
      }
    }

    this.pump(); // kick off processing if idle
    return created;
  }

  getJob(id: string): SearchJob | undefined {
    return this.jobs.get(id);
  }

  getAllJobs(): SearchJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  getAllResults(): UniversalLead[] {
    const out: UniversalLead[] = [];
    for (const job of this.jobs.values()) {
      if (job.status === "done") out.push(...job.results);
    }
    return out;
  }

  clearCompleted(): void {
    for (const [id, job] of this.jobs) {
      if (job.status === "done" || job.status === "failed") {
        this.jobs.delete(id);
      }
    }
  }

  clearAll(): void {
    this.jobs.clear();
    this.pending = [];
  }

  // ── Internal processor ───────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    while (this.pending.length > 0) {
      const jobId = this.pending.shift()!;
      const job = this.jobs.get(jobId);
      if (!job) continue;

      const scraper = this.scrapers.get(job.scraperId);
      if (!scraper) {
        job.status = "failed";
        job.error = `Unknown scraper: ${job.scraperId}`;
        job.finishedAt = Date.now();
        continue;
      }

      job.status = "running";
      job.startedAt = Date.now();

      try {
        job.results = await scraper.search(job.keyword, job.location, job.country);
        job.resultCount = job.results.length;
        job.status = "done";
      } catch (err) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      } finally {
        job.finishedAt = Date.now();
      }
    }

    this.processing = false;
  }
}
