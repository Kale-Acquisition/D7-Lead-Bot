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
    this.pauseReason = null;
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
      const nextId  = this.pending[0];
      const nextJob = this.jobs.get(nextId);

      if (!nextJob) { this.pending.shift(); continue; }

      if (nextJob.scraperId === "d7-bulk") {
        await this.processBulkBatch();
      } else {
        await this.processSingleJob();
      }
    }

    this.processing = false;
  }

  /** Process one non-bulk job from the front of the queue. */
  private async processSingleJob(): Promise<void> {
    const jobId = this.pending.shift()!;
    const job   = this.jobs.get(jobId);
    if (!job) return;

    const scraper = this.scrapers.get(job.scraperId);
    if (!scraper) {
      job.status     = "failed";
      job.error      = `Unknown scraper: ${job.scraperId}`;
      job.finishedAt = Date.now();
      return;
    }

    job.status    = "running";
    job.startedAt = Date.now();

    try {
      job.results     = await scraper.search(job.keywords, job.location, job.country);
      job.resultCount = job.results.length;
      job.status      = "done";
    } catch (err) {
      if (err instanceof StoppedError) {
        job.status = "queued";
        this.pending.unshift(jobId);

      } else if (err instanceof PauseError) {
        job.status       = "queued";
        this.pending.unshift(jobId);
        this.stopped     = true;
        this.pauseReason = err.message;
        console.warn(`[queue] Paused — ${err.message}`);
        for (const s of this.scrapers.values()) {
          if (s instanceof D7BulkScraper) s.stop();
        }

      } else {
        job.status     = "failed";
        job.error      = err instanceof Error ? err.message : String(err);
        job.finishedAt = Date.now();
      }
    } finally {
      if (job.status !== "queued") job.finishedAt = Date.now();
    }
  }

  /**
   * Two-phase batch processor for d7-bulk jobs:
   *
   * Phase 1 — Submit every consecutive d7-bulk job (65 s apart).
   *            D7 processes them all in parallel on their side.
   *
   * Phase 2 — Download results for each submitted search in sequence.
   *            Results are combined automatically by getAllResults().
   */
  private async processBulkBatch(): Promise<void> {
    const scraper = this.scrapers.get("d7-bulk");
    if (!(scraper instanceof D7BulkScraper)) {
      await this.processSingleJob();
      return;
    }

    // Collect all consecutive pending d7-bulk job IDs
    const batchIds: string[] = [];
    for (const id of this.pending) {
      if (this.jobs.get(id)?.scraperId === "d7-bulk") batchIds.push(id);
      else break;
    }

    // Remove them all from pending upfront
    this.pending.splice(0, batchIds.length);

    // ── Phase 1: Submit all searches ────────────────────────────────────────

    const submissions: Array<{ jobId: string; refName: string; keywordCount: number }> = [];

    for (let i = 0; i < batchIds.length; i++) {
      if (this.stopped) break;

      const jobId = batchIds[i];
      const job   = this.jobs.get(jobId)!;
      job.status    = "running";
      job.startedAt = Date.now();

      try {
        const { refName, keywordCount } = await scraper.submitBulkJob(job.keywords, job.location);
        submissions.push({ jobId, refName, keywordCount });
        console.log(`[queue] Submitted ${i + 1}/${batchIds.length}: ${job.location}`);

        // Wait 65 s before the next submission (D7 rate limit)
        if (i < batchIds.length - 1 && !this.stopped) {
          console.log("[queue] Waiting 65 s before next bulk submission…");
          await new Promise((r) => setTimeout(r, 65000));
        }

      } catch (err) {
        if (err instanceof StoppedError) {
          // Re-queue this job and all not-yet-submitted ones
          const requeue = [jobId, ...batchIds.slice(i + 1)];
          for (const id of requeue) {
            const j = this.jobs.get(id);
            if (j) j.status = "queued";
          }
          this.pending.unshift(...requeue);
          return; // this.stopped already set by stop()

        } else if (err instanceof PauseError) {
          const requeue = [jobId, ...batchIds.slice(i + 1)];
          for (const id of requeue) {
            const j = this.jobs.get(id);
            if (j) j.status = "queued";
          }
          this.pending.unshift(...requeue);
          this.stopped     = true;
          this.pauseReason = err.message;
          console.warn(`[queue] Paused — ${err.message}`);
          scraper.stop();
          return;

        } else {
          // LocationNotFoundError or other non-recoverable — fail, keep going
          job.status     = "failed";
          job.error      = err instanceof Error ? err.message : String(err);
          job.finishedAt = Date.now();
        }
      }
    }

    if (this.stopped) return;

    // ── Phase 2: Download results (D7 processed them in parallel) ────────────

    console.log(`[queue] All ${submissions.length} searches submitted — now downloading results…`);

    for (const { jobId, refName, keywordCount } of submissions) {
      if (this.stopped) break;

      const job = this.jobs.get(jobId)!;

      try {
        job.results     = await scraper.downloadBulkJob(refName, keywordCount);
        job.resultCount = job.results.length;
        job.status      = "done";
        job.finishedAt  = Date.now();

      } catch (err) {
        if (err instanceof StoppedError) {
          job.status     = "failed";
          job.error      = "Stopped before results could be downloaded";
          job.finishedAt = Date.now();

        } else if (err instanceof PauseError) {
          job.status     = "failed";
          job.error      = `Download error: ${err.message}`;
          job.finishedAt = Date.now();
          this.stopped     = true;
          this.pauseReason = err.message;
          scraper.stop();
          return;

        } else {
          job.status     = "failed";
          job.error      = err instanceof Error ? err.message : String(err);
          job.finishedAt = Date.now();
        }
      }
    }
  }
}
