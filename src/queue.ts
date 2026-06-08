import { randomUUID } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { IScraper, SearchJob, UniversalLead, PauseError, StoppedError } from "./scrapers/types";
import { D7BulkScraper } from "./scrapers/d7-bulk";

const STATE_FILE = resolve(__dirname, "../.queue-state.json");

export class JobQueue {
  private jobs: Map<string, SearchJob> = new Map();
  private pending: string[] = [];
  private processing = false;
  private stopped = false;
  private pauseReason: string | null = null;
  private scrapers: Map<string, IScraper> = new Map();
  private onScheduledBatchComplete?: (jobs: SearchJob[], filename: string) => void;
  private firedScheduledExports: Set<number> = new Set();

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
    scraperId: string,
    scheduledFor?: number
  ): SearchJob[] {
    const created: SearchJob[] = [];
    const runAt = scheduledFor && scheduledFor > Date.now() ? scheduledFor : undefined;

    for (const rawLocation of locations) {
      const location = rawLocation.trim().replace(/\s+/g, " ");
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
        scheduledFor: runAt,
      };
      this.jobs.set(job.id, job);

      if (runAt) {
        // Delay adding to pending queue until the scheduled time
        const delay = runAt - Date.now();
        setTimeout(() => {
          this.pending.push(job.id);
          if (!this.stopped) this.pump();
        }, delay);
      } else {
        this.pending.push(job.id);
      }

      created.push(job);
    }

    this.saveState();
    if (!this.stopped && !runAt) this.pump();
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
    this.saveState();
  }

  clearAll(): void {
    this.jobs.clear();
    this.pending = [];
    this.saveState();
  }

  clearResults(): void {
    for (const job of this.jobs.values()) {
      if (job.status === "done") {
        job.results = [];
        job.resultCount = 0;
      }
    }
    this.saveState();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  saveState(): void {
    try {
      writeFileSync(STATE_FILE, JSON.stringify({
        jobs:    Array.from(this.jobs.entries()),
        stopped: this.stopped,
      }), "utf8");
    } catch (err) {
      console.error("[queue] Failed to save state:", err);
    }
  }

  restoreState(): void {
    if (!existsSync(STATE_FILE)) return;
    try {
      const { jobs, stopped } = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      for (const [id, job] of jobs as [string, SearchJob][]) {
        // Jobs that were mid-run when the server stopped — reset them so they retry
        if (job.status === "running") job.status = "queued";
        this.jobs.set(id, job);
      }
      this.stopped = stopped ?? false;

      // Re-queue all queued jobs, respecting future schedules
      for (const job of this.jobs.values()) {
        if (job.status !== "queued") continue;
        if (job.scheduledFor && job.scheduledFor > Date.now()) {
          const delay = job.scheduledFor - Date.now();
          setTimeout(() => {
            this.pending.push(job.id);
            if (!this.stopped) this.pump();
          }, delay);
        } else {
          this.pending.push(job.id);
        }
      }

      console.log(`[queue] Restored ${this.jobs.size} jobs (${this.pending.length} ready, scheduled timers re-armed)`);
      if (!this.stopped && this.pending.length > 0) this.pump();
    } catch (err) {
      console.error("[queue] Failed to restore state:", err);
    }
  }

  // ── Scheduled-batch auto-export ───────────────────────────────────────────

  setOnScheduledBatchComplete(cb: (jobs: SearchJob[], filename: string) => void): void {
    this.onScheduledBatchComplete = cb;
  }

  /** Build a Compiled_FirstCity-LastCity.csv filename from a set of jobs. */
  getFilename(jobs?: SearchJob[]): string {
    const source = (jobs ?? Array.from(this.jobs.values()).filter(j => j.status === "done"))
      .sort((a, b) => a.createdAt - b.createdAt);
    if (!source.length) return "leads.csv";
    const clean = (s: string) => s.split(",")[0].trim().replace(/[^\w\- ]/g, "").replace(/\s+/g, "_");
    const first = clean(source[0].location);
    const last  = clean(source[source.length - 1].location);
    return first === last ? `Compiled_${first}.csv` : `Compiled_${first}-${last}.csv`;
  }

  private checkScheduledBatch(scheduledFor: number): void {
    if (!this.onScheduledBatchComplete) return;
    if (this.firedScheduledExports.has(scheduledFor)) return;
    const batch = Array.from(this.jobs.values()).filter(j => j.scheduledFor === scheduledFor);
    if (!batch.length) return;
    if (!batch.every(j => j.status === "done" || j.status === "failed")) return;
    this.firedScheduledExports.add(scheduledFor);
    this.onScheduledBatchComplete(batch, this.getFilename(batch));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Sleep for `ms` milliseconds, waking early if the queue is stopped. */
  private async interruptibleSleep(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.stopped) {
      await new Promise<void>((r) => setTimeout(r, 500));
    }
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
    if (job.scheduledFor !== undefined && job.status !== "queued") {
      this.checkScheduledBatch(job.scheduledFor);
    }
    this.saveState();
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

    // ── Phase 1: Submit all searches (skip jobs already submitted in a prior run) ─

    const submissions: Array<{ jobId: string; refName: string; keywordCount: number }> = [];

    for (let i = 0; i < batchIds.length; i++) {
      if (this.stopped) break;

      const jobId = batchIds[i];
      const job   = this.jobs.get(jobId)!;
      job.status    = "running";
      job.startedAt = Date.now();

      try {
        let refName: string;
        let keywordCount: number;

        if (job.bulkRefName) {
          // Already submitted in a previous run — go straight to Phase 2
          refName      = job.bulkRefName;
          keywordCount = job.bulkKeywordCount ?? job.keywords.length;
          console.log(`[queue] Skipping re-submit for ${job.location} (already submitted as "${refName}")`);
        } else {
          const result = await scraper.submitBulkJob(job.keywords, job.location);
          refName      = result.refName;
          keywordCount = result.keywordCount;
          job.bulkRefName      = refName;
          job.bulkKeywordCount = keywordCount;
          this.saveState();
          console.log(`[queue] Submitted ${i + 1}/${batchIds.length}: ${job.location}`);

          // Wait 65 s before the next new submission (D7 rate limit, interruptible)
          if (i < batchIds.length - 1 && !this.stopped) {
            console.log("[queue] Waiting 65 s before next bulk submission…");
            await this.interruptibleSleep(65000);
          }
        }

        submissions.push({ jobId, refName, keywordCount });

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

    // ── Phase 2: Opportunistic download — process whichever cities are ready ──
    // Scan the history page once per cycle; download all cities that have a
    // View button, skip cities still "Joining Data", wait only when nothing
    // is ready. This avoids blocking on slow cities while faster ones sit idle.

    console.log(`[queue] All ${submissions.length} searches submitted — now downloading results…`);

    const pending = new Map(submissions.map(s => [s.refName, s]));
    const maxWait  = 4 * 60 * 60 * 1000; // 4-hour hard timeout
    const phaseStart = Date.now();

    while (pending.size > 0) {
      if (this.stopped) {
        const remaining = Array.from(pending.values()).map(s => ({ jobId: s.jobId }));
        this.failRemaining(remaining, 0, "Download interrupted — click Restart Downloads to retry");
        this.saveState();
        return;
      }

      if (Date.now() - phaseStart > maxWait) {
        const remaining = Array.from(pending.values()).map(s => ({ jobId: s.jobId }));
        this.failRemaining(remaining, 0, "Download timed out after 4 hours");
        this.saveState();
        return;
      }

      // Single history-page scan to find all ready cities
      let readyRefNames: Set<string>;
      try {
        readyRefNames = await scraper.scanReadyJobs(Array.from(pending.keys()));
      } catch (err) {
        if (err instanceof StoppedError) {
          const remaining = Array.from(pending.values()).map(s => ({ jobId: s.jobId }));
          this.failRemaining(remaining, 0, "Download interrupted — click Restart Downloads to retry");
          this.saveState();
          return;
        }
        // Transient scan error — wait 30 s and retry
        console.warn(`[queue] History scan failed: ${err instanceof Error ? err.message : err} — retrying in 30 s`);
        await this.interruptibleSleep(30000);
        continue;
      }

      if (readyRefNames.size > 0) {
        console.log(`[queue] ${readyRefNames.size} / ${pending.size} cities ready — downloading…`);
      }

      let downloadedAny = false;

      for (const refName of readyRefNames) {
        if (this.stopped) break;
        const { jobId, keywordCount } = pending.get(refName)!;
        const job = this.jobs.get(jobId)!;

        try {
          job.results     = await scraper.downloadBulkJob(refName, keywordCount);
          job.resultCount = job.results.length;
          job.status      = "done";
          job.finishedAt  = Date.now();
          pending.delete(refName);
          downloadedAny = true;
          if (job.scheduledFor !== undefined) this.checkScheduledBatch(job.scheduledFor);

        } catch (err) {
          if (err instanceof StoppedError) {
            const remaining = Array.from(pending.values()).map(s => ({ jobId: s.jobId }));
            this.failRemaining(remaining, 0, "Download interrupted — click Restart Downloads to retry");
            this.saveState();
            return;

          } else if (err instanceof PauseError) {
            job.status     = "failed";
            job.error      = `Download error: ${err.message}`;
            job.finishedAt = Date.now();
            pending.delete(refName);
            const remaining = Array.from(pending.values()).map(s => ({ jobId: s.jobId }));
            this.failRemaining(remaining, 0, "Download interrupted — click Restart Downloads to retry");
            this.stopped     = true;
            this.pauseReason = err.message;
            scraper.stop();
            this.saveState();
            return;

          } else {
            job.status     = "failed";
            job.error      = err instanceof Error ? err.message : String(err);
            job.finishedAt = Date.now();
            pending.delete(refName);
          }
        }
        this.saveState();
      }

      // Nothing was ready this cycle — wait 5 min before scanning again
      if (!downloadedAny && pending.size > 0) {
        console.log(`[queue] ${pending.size} cities still processing on D7 — waiting 5 min…`);
        await this.interruptibleSleep(5 * 60 * 1000);
      }
    }
  }

  private failRemaining(
    submissions: Array<{ jobId: string }>,
    fromIndex: number,
    reason: string
  ): void {
    for (const { jobId } of submissions.slice(fromIndex)) {
      const j = this.jobs.get(jobId);
      if (j && (j.status === "running" || j.status === "queued")) {
        j.status     = "failed";
        j.error      = reason;
        j.finishedAt = Date.now();
      }
    }
  }

  retryDownloads(): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.scraperId !== "d7-bulk" || !job.bulkRefName) continue;
      if (job.status === "running" || job.status === "failed") {
        job.status     = "queued";
        job.error      = undefined;
        job.finishedAt = undefined;
        if (!this.pending.includes(job.id)) {
          this.pending.push(job.id);
          count++;
        }
      }
    }
    if (count > 0) {
      this.stopped     = false;
      this.pauseReason = null;
      this.saveState();
      this.pump();
    }
    return count;
  }
}
