import { chromium, Browser, BrowserContext, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { IScraper, UniversalLead } from "./types";

const LOGIN_URL = "https://dash.d7leadfinder.com/app/login/";
const BULK_URL = "https://dash.d7leadfinder.com/app/bulk/";
const SESSION_FILE = path.join(process.cwd(), ".d7-session.json");

export class D7BulkScraper implements IScraper {
  readonly id = "d7-bulk";
  readonly name = "D7 Bulk Search (Browser)";

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(
    private email: string,
    private password: string,
    private headless = false
  ) {}

  // ── Browser / session management ─────────────────────────────────────────

  private async getContext(): Promise<BrowserContext> {
    if (!this.browser) {
      this.browser = await chromium.launch({ headless: this.headless });
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

  private async saveSession(): Promise<void> {
    if (!this.context) return;
    const state = await this.context.storageState();
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state));
  }

  private async ensureLoggedIn(page: Page): Promise<void> {
    await page.goto(BULK_URL, { waitUntil: "domcontentloaded" });

    // If redirected to login page, log in
    if (page.url().includes("/login/")) {
      await page.fill('input[type="email"], input[name="email"], input[name="username"]', this.email);
      await page.fill('input[type="password"], input[name="password"]', this.password);
      await page.click('button[type="submit"], input[type="submit"]');
      await page.waitForURL("**/app/**", { timeout: 15000 });
      await this.saveSession();

      // Navigate to bulk search after login
      await page.goto(BULK_URL, { waitUntil: "domcontentloaded" });
    }
  }

  // ── Main search ───────────────────────────────────────────────────────────

  async search(keywords: string[], location: string, _country = "US"): Promise<UniversalLead[]> {
    const context = await this.getContext();
    const page = await context.newPage();

    try {
      await this.ensureLoggedIn(page);
      await page.waitForTimeout(1000);

      // ── 1. Select location ──────────────────────────────────────────────
      await this.selectLocation(page, location);

      // ── 2. Fill keywords textarea ───────────────────────────────────────
      const textarea = page.locator("textarea").first();
      await textarea.click();
      await textarea.fill(keywords.join("\n"));

      // ── 3. Fill reference / filename ────────────────────────────────────
      const dateStr = new Date().toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
      const refName = `${location} — ${dateStr}`;
      // Reference input is usually the last text input on the form
      const refInput = page.locator('input[type="text"]').last();
      await refInput.fill(refName);

      // ── 4. Submit ────────────────────────────────────────────────────────
      await page.click('button:has-text("Fetch Leads"), input[value*="Fetch"]');

      // Wait for redirect to the bulk view page
      await page.waitForURL("**/bulk/view/**", { timeout: 30000 });

      const bulkUrl = page.url();
      console.log(`Bulk search submitted → ${bulkUrl}`);

      // ── 5. Wait for D7 to finish processing ─────────────────────────────
      await this.waitForProcessing(page, keywords.length);

      // ── 6. Download CSV and parse ────────────────────────────────────────
      const results = await this.downloadCsv(page);
      console.log(`Bulk search done — ${results.length} leads`);
      return results;

    } finally {
      await page.close();
    }
  }

  // ── Location dropdown ─────────────────────────────────────────────────────
  // D7 uses a Select2 dropdown for location selection

  private async selectLocation(page: Page, location: string): Promise<void> {
    // Select2: click the container to open it
    const select2Container = page.locator(".select2-container, .select2-selection").first();
    await select2Container.click();
    await page.waitForTimeout(500);

    // Type in the search field that appears
    const searchField = page.locator(".select2-search__field, .select2-search input").first();
    await searchField.fill(location);
    await page.waitForTimeout(1500); // wait for results to load

    // Click the first matching result
    const firstOption = page.locator(".select2-results__option").first();
    await firstOption.waitFor({ timeout: 5000 });
    await firstOption.click();
    await page.waitForTimeout(500);
  }

  // ── Wait for all keyword rows to finish ───────────────────────────────────

  private async waitForProcessing(page: Page, keywordCount: number): Promise<void> {
    const maxWait = 30 * 60 * 1000; // 30 minutes max
    const pollInterval = 15 * 1000; // check every 15s
    const start = Date.now();

    console.log(`Waiting for D7 to process ${keywordCount} keyword(s)…`);

    while (Date.now() - start < maxWait) {
      await page.waitForTimeout(pollInterval);
      await page.reload({ waitUntil: "domcontentloaded" });

      // Count rows that have a "View Single List" link (= done)
      const doneRows = await page.locator('a:has-text("View Single List")').count();
      console.log(`  ${doneRows}/${keywordCount} complete`);

      if (doneRows >= keywordCount) break;
    }
  }

  // ── Download CSV from the bulk view page ──────────────────────────────────

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

    // Parse header row
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
    await this.context?.close();
    await this.browser?.close();
    this.browser = null;
    this.context = null;
  }
}
