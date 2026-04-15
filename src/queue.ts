import { randomUUID } from "crypto";
import { IScraper, SearchJob, UniversalLead, PauseError, StoppedError } from "./scrapers/types";
import { D7BulkScraper } from "./scrapers/d7-bulk";

export class JobQueue {
  private jobs: Map<string, SearchJob> = new Map();
  private pending: string[] = [];
  private processing = false;
  private stopped = false;
  private pauseReason: string | null = null;
  private scrapers: Map<string, IScraper> = new Map();

  // ── Scraper registry ──────────────────────────────────────────────────────

  registerScraper(scraper: IScraper): void {
    this.scrapers.set(scraper.id, scraper);
  }

  getScraper(id: string): IScraper | undefined {
    return this.scrapers.get(id);
  }

  listScrapers(): Array<{ id: string; name: string }> {
    return Array.from(this.scrapers.values()).map((s) => ({ id: s.id, name: s.name }));
  }

  // ── Stop / Resume ─────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
    this.pauseReason = null; // manual stop has no auto-reason
    for (const scraper of this.scrapers.values()) {
      if (scraper instanceof D7BulkScraper) scraper.stop();
    }
  }

  resume(): void {
    this.stopped = false;
    this.pauseReason = null;
    for (const scraper of this.scrapers.values()) {
      if (scraper instanceof D7BulkScraper) scraper.resume();
    }
    this.pump();
  }

  getStatus(): { stopped: boolean; processing: boolean; pendingCount: number; pauseReason: string | null } {
    return {
      stopped:      this.stopped,
      processing:   this.processing,
      pendingCount: this.pending.length,
      pauseReason:  this.pauseReason,
    };
  }

  // ── Job management ────────────────────────────────────────────────────────

  enqueue(
    keywords: string[],
    locations: string[],
    country: string,
    scraperId: string
  ): SearchJob[] {
    const created: SearchJob[] = [];

    for (const location of locations) {
      const job: SearchJob = {
        id: randomUUID(),
        keywords,
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

    if (!this.stopped) this.pump();
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

  // ── Internal processor ────────────────────────────────────────────────────

  private async pump(): Promise<void> {
    if (this.processing || this.stopped) return;
    this.processing = true;

    while (this.pending.length > 0 && !this.stopped) {
      const jobId = this.pending.shift()!;
      const job   = this.jobs.get(jobId);
      if (!job) continue;

      const scraper = this.scrapers.get(job.scraperId);
      if (!scraper) {
        job.status     = "failed";
        job.error      = `Unknown scraper: ${job.scraperId}`;
        job.finishedAt = Date.now();
        continue;
      }

      job.status    = "running";
      job.startedAt = Date.now();

      try {
        job.results     = await scraper.search(job.keywords, job.location, job.country);
        job.resultCount = job.results.length;
        job.status      = "done";
      } catch (err) {
        if (err instanceof StoppedError) {
          // User manually stopped — re-queue, halt loop
          job.status = "queued";
          this.pending.unshift(jobId);
          break;

        } else if (err instanceof PauseError) {
          // Something went wrong (quota, network, crash) — re-queue, pause, show reason
          job.status        = "queued";
          this.pending.unshift(jobId);
          this.stopped      = true;
          this.pauseReason  = err.message;
          console.warn(`[queue] Paused — ${err.message}`);
          for (const s of this.scrapers.values()) {
            if (s instanceof D7BulkScraper) s.stop();
          }
          break;

        } else {
          // Non-recoverable (e.g. LocationNotFoundError) — mark failed, continue queue
          job.status     = "failed";
          job.error      = err instanceof Error ? err.message : String(err);
          job.finishedAt = Date.now();
        }
      } finally {
        if (job.status !== "queued") job.finishedAt = Date.now();
      }
    }

    this.processing = false;
  }
}
