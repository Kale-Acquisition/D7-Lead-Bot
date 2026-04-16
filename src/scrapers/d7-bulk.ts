import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { IScraper, UniversalLead, PauseError, StoppedError } from "./types";

const LOGIN_URL    = "https://dash.d7leadfinder.com/auth/login/";
const BULK_URL     = "https://dash.d7leadfinder.com/app/bulk/";
const SESSION_FILE = path.join(process.cwd(), ".d7-session.json");
const MAX_RETRIES  = 3;

class LocationNotFoundError extends Error {
  constructor(location: string) { super(`Location not found in D7: "${location}"`); }
}

export class D7BulkScraper implements IScraper {
  readonly id   = "d7-bulk";
  readonly name = "D7 Bulk Search (Browser)";

  private browser: Browser | null       = null;
  private context: BrowserContext | null = null;
  private stopped    = false;
  private loginState: "idle" | "waiting" | "connected" | "error" = "idle";
  private loginError: string | null = null;

  constructor(
    private email: string,
    private password: string,
    private headless = true          // invisible by default — no window interference
  ) {}

  // ── Manual login (for CAPTCHA) ────────────────────────────────────────────

  /** Opens a visible browser so the user can solve the CAPTCHA once.
   *  Credentials are pre-filled — user only needs to solve CAPTCHA and submit. */
  async loginManually(): Promise<void> {
    this.loginState = "waiting";
    this.loginError = null;

    const visibleBrowser = await chromium.launch({ headless: false });
    const ctx  = await visibleBrowser.newContext();
    const page = await ctx.newPage();

    try {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });

      // Pre-fill credentials so user only needs to handle the CAPTCHA
      await page.fill('input[type="email"], input[name="email"], input[name="username"]', this.email).catch(() => {});
      await page.fill('input[type="password"], input[name="password"]', this.password).catch(() => {});

      console.log("[d7-bulk] Browser opened — waiting for you to solve the CAPTCHA…");

      // Wait up to 5 minutes for the user to complete login
      await page.waitForURL(
        (url) => !url.toString().includes("/login/") && !url.toString().includes("/auth/"),
        { timeout: 5 * 60 * 1000 }
      );

      // Save session so future headless runs skip login entirely
      const state = await ctx.storageState();
      fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
      this.loginState = "connected";
      console.log("[d7-bulk] Login successful — session saved.");

    } catch (err) {
      this.loginState = "error";
      this.loginError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      await page.close().catch(() => {});
      await visibleBrowser.close().catch(() => {});
    }
  }

  getLoginState(): { state: string; hasSession: boolean; error?: string } {
    return {
      state:      this.loginState,
      hasSession: fs.existsSync(SESSION_FILE),
      error:      this.loginError ?? undefined,
    };
  }

  // ── Stop control ──────────────────────────────────────────────────────────

  stop(): void {
    this.stopped = true;
  }

  resume(): void {
    this.stopped = false;
  }

  private checkStopped(): void {
    if (this.stopped) throw new StoppedError();  // user manually stopped
  }

  // ── Browser / session ─────────────────────────────────────────────────────

  private async getContext(): Promise<BrowserContext> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await chromium.launch({ headless: this.headless });
      this.context = null; // force new context on new browser
    }
    if (!this.context) {
      if (fs.existsSync(SESSION_FILE)) {
        try {
          const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
          this.context = await this.browser.newContext({ storageState: state });
        } catch {
          this.context = await this.browser.newContext();
        }
      } else {
        this.context = await this.browser.newContext();
      }
    }
    return this.context;
  }

  /** Close browser + context so next attempt starts completely fresh. */
  private async resetBrowser(): Promise<void> {
    try { await this.context?.close(); } catch { /* ignore */ }
    try { await this.browser?.close(); } catch { /* ignore */ }
    this.browser  = null;
    this.context  = null;
  }


  // ── Public search (with retries + crash recovery) ─────────────────────────

  async search(keywords: string[], location: string, _country = "US"): Promise<UniversalLead[]> {
    let lastError: Error = new Error("Unknown error");

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      this.checkStopped();

      try {
        return await this.doSearch(keywords, location);
      } catch (err) {
        if (err instanceof StoppedError) throw err;       // never retry a stop
        if (err instanceof LocationNotFoundError) throw err; // never retry a missing city

        lastError = err instanceof Error ? err : new Error(String(err));
        console.error(`[d7-bulk] Attempt ${attempt}/${MAX_RETRIES} failed: ${lastError.message}`);

        await this.resetBrowser(); // fresh browser for next attempt

        if (attempt < MAX_RETRIES) {
          const backoff = attempt * 3000;
          console.log(`[d7-bulk] Retrying in ${backoff / 1000}s…`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    // All retries exhausted — pause the queue so the user can investigate
    throw new PauseError(lastError.message);
  }

  // ── Core search logic ─────────────────────────────────────────────────────

  private async doSearch(keywords: string[], location: string): Promise<UniversalLead[]> {
    const context = await this.getContext();
    const page    = await context.newPage();

    try {
      // 1. Login
      this.checkStopped();
      await this.ensureLoggedIn(page);
      await page.waitForTimeout(800);

      // 2. Select location
      this.checkStopped();
      await this.selectLocation(page, location);

      // 3. Fill keywords
      this.checkStopped();
      const textarea = page.locator("textarea").first();
      await textarea.click();
      await textarea.fill(keywords.join("\n"));

      // 4. Fill reference name
      this.checkStopped();
      const dateStr  = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      const refName  = `${location} — ${dateStr}`;
      const refInput = page.locator('input[type="text"]').last();
      await refInput.fill(refName);

      // 5. Submit
      this.checkStopped();
      await page.click('button:has-text("Fetch Leads"), input[value*="Fetch"]');
      await page.waitForURL("**/bulk/view/**", { timeout: 30000 });
      console.log(`[d7-bulk] Submitted → ${page.url()}`);

      // 6. Wait for D7 to process
      await this.waitForProcessing(page, keywords.length);

      // 7. Download CSV
      this.checkStopped();
      const results = await this.downloadCsv(page);
      console.log(`[d7-bulk] Done — ${results.length} leads`);
      return results;

    } finally {
      await page.close().catch(() => {});
    }
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  private isLoginPage(url: string): boolean {
    return url.includes("/login/") || url.includes("/auth/");
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    await page.goto(BULK_URL, { waitUntil: "domcontentloaded" });

    if (!this.isLoginPage(page.url())) return; // session is valid, already inside

    // D7 has CAPTCHA — automated login is blocked. User must log in manually once.
    this.loginState = "error";
    throw new PauseError('D7 login required — click "Connect D7 Account" in the UI to authenticate');
  }

  // ── Location dropdown (Select2) ───────────────────────────────────────────

  private async selectLocation(page: Page, location: string): Promise<void> {
    await page.locator(".select2-container, .select2-selection").first().click();
    await page.waitForTimeout(400);

    const searchField = page.locator(".select2-search__field, .select2-search input").first();
    await searchField.fill(location);
    await page.waitForTimeout(1500);

    // Check for "no results" before trying to click
    const noResults = page.locator(".select2-results__option--disabled, .select2-results__message");
    const firstOption = page.locator(".select2-results__option:not(.select2-results__option--disabled)").first();

    // Wait up to 6s for either a valid option or a no-results message
    await Promise.race([
      firstOption.waitFor({ timeout: 6000 }),
      noResults.waitFor({ timeout: 6000 }),
    ]).catch(() => { throw new LocationNotFoundError(location); });

    // If no valid option exists, the city wasn't found
    const hasOption = await firstOption.isVisible().catch(() => false);
    if (!hasOption) throw new LocationNotFoundError(location);

    await firstOption.click();
    await page.waitForTimeout(400);
  }

  // ── Wait for processing ───────────────────────────────────────────────────

  private async waitForProcessing(page: Page, keywordCount: number): Promise<void> {
    const maxWait      = 30 * 60 * 1000; // 30 min
    const pollInterval = 15 * 1000;
    const start        = Date.now();

    console.log(`[d7-bulk] Waiting for ${keywordCount} keyword(s) to process…`);

    while (Date.now() - start < maxWait) {
      this.checkStopped();

      await page.waitForTimeout(pollInterval);
      await page.reload({ waitUntil: "domcontentloaded" });

      const doneRows = await page.locator('a:has-text("View Single List")').count();
      console.log(`[d7-bulk]   ${doneRows}/${keywordCount} done`);

      if (doneRows >= keywordCount) return;
    }

    throw new Error(`Timed out waiting for D7 to process ${keywordCount} keywords`);
  }

  // ── Download CSV ──────────────────────────────────────────────────────────

  private async downloadCsv(page: Page): Promise<UniversalLead[]> {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.click('a:has-text("Download All (CSV)"), button:has-text("Download All (CSV)")'),
    ]);

    const tmpPath = path.join(process.cwd(), ".tmp-bulk-download.csv");
    await download.saveAs(tmpPath);

    const csv = fs.readFileSync(tmpPath, "utf8");
    fs.unlinkSync(tmpPath);

    return this.parseCsv(csv);
  }

  // ── CSV parser ────────────────────────────────────────────────────────────

  private parseCsv(csv: string): UniversalLead[] {
    const lines = csv.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return [];

    const headers = this.splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());

    const col = (row: string[], ...names: string[]): string => {
      for (const name of names) {
        const i = headers.indexOf(name);
        if (i !== -1 && row[i]) return row[i].trim();
      }
      return "";
    };

    return lines.slice(1).map((line) => {
      const row = this.splitCsvLine(line);
      return {
        name:        col(row, "company name", "name", "business name"),
        phone:       col(row, "phone", "telephone", "phone number"),
        email:       col(row, "email", "email address"),
        website:     col(row, "website", "url", "web"),
        address:     [col(row, "address", "address1"), col(row, "city"), col(row, "state"), col(row, "zip", "postcode")].filter(Boolean).join(", "),
        category:    col(row, "category", "keyword", "type"),
        googleStars: col(row, "google rating", "google stars", "googlestars"),
        googleCount: col(row, "google reviews", "google count", "googlecount"),
        yelpStars:   col(row, "yelp rating", "yelp stars", "yelpstars"),
        yelpCount:   col(row, "yelp reviews", "yelp count", "yelpcount"),
        fbStars:     col(row, "facebook rating", "fb stars", "fbstars"),
        fbCount:     col(row, "facebook reviews", "fb count", "fbcount"),
      };
    });
  }

  private splitCsvLine(line: string): string[] {
    const result: string[] = [];
    let current = "";
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === "," && !inQuotes) { result.push(current); current = ""; continue; }
      current += ch;
    }
    result.push(current);
    return result;
  }

  async close(): Promise<void> {
    await this.resetBrowser();
  }
}
