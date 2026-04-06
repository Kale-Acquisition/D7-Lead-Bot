import "dotenv/config";
import { Command } from "commander";
import { D7Client } from "./d7client";
import { Lead } from "./types";
import { writeFileSync } from "fs";
import { resolve } from "path";

const program = new Command();

program
  .name("d7")
  .description("Fetch business leads from D7 Lead Finder by keyword and city")
  .version("1.0.0");

program
  .command("search")
  .description("Search for leads")
  .requiredOption("-k, --keyword <keyword>", "Business type / keyword (e.g. Dentists)")
  .requiredOption("-c, --city <city>", "City name (e.g. Austin)")
  .option("--country <country>", "ISO 2-char country code", "US")
  .option("--json", "Output raw JSON instead of a table")
  .option("--csv [file]", "Write results to a CSV file (default: leads.csv)")
  .action(async (opts) => {
    const apiKey = process.env.D7_API_KEY;
    if (!apiKey) {
      console.error("Error: D7_API_KEY is not set in .env");
      process.exit(1);
    }

    const client = new D7Client(apiKey);

    console.log(`Searching for "${opts.keyword}" in ${opts.city} …`);

    const leads = await client.search(
      opts.keyword,
      opts.city,
      opts.country,
      (secs) => console.log(`Waiting ${secs}s for results to be ready…`)
    );

    if (leads.length === 0) {
      console.log("No leads found.");
      return;
    }

    console.log(`Found ${leads.length} lead(s).\n`);

    if (opts.csv !== undefined) {
      const filename = typeof opts.csv === "string" ? opts.csv : "leads.csv";
      const outPath = resolve(filename);
      writeCsv(leads, outPath);
      console.log(`CSV saved to ${outPath}`);
    } else if (opts.json) {
      console.log(JSON.stringify(leads, null, 2));
    } else {
      printTable(leads);
    }
  });

program
  .command("account")
  .description("Show today's API quota usage")
  .action(async () => {
    const apiKey = process.env.D7_API_KEY;
    if (!apiKey) {
      console.error("Error: D7_API_KEY is not set.");
      process.exit(1);
    }
    const client = new D7Client(apiKey);
    const info = await client.account();
    console.log("Daily limit  :", info.daily_limit);
    console.log("Used today   :", info.used_today);
    console.log("Remaining    :", info.today_remaining);
    console.log("Resets in    :", info.seconds_to_reset, "seconds");
  });

program
  .command("history")
  .description("Show past searches (up to 500)")
  .action(async () => {
    const apiKey = process.env.D7_API_KEY;
    if (!apiKey) {
      console.error("Error: D7_API_KEY is not set.");
      process.exit(1);
    }
    const client = new D7Client(apiKey);
    const entries = await client.history();
    if (entries.length === 0) {
      console.log("No search history found.");
      return;
    }
    console.table(
      entries.map((e) => ({
        Date: e.date,
        Keyword: e.keyword,
        City: e.city,
        State: e.state,
        ID: e.searchid,
      }))
    );
  });

program
  .command("keywords")
  .description("Show suggested keywords")
  .action(async () => {
    const apiKey = process.env.D7_API_KEY;
    if (!apiKey) {
      console.error("Error: D7_API_KEY is not set.");
      process.exit(1);
    }
    const client = new D7Client(apiKey);
    const kws = await client.keywords();
    kws.forEach((k) => console.log(" •", k));
  });

program.parse();

// ── helpers ────────────────────────────────────────────────────────────────

function writeCsv(leads: Lead[], filePath: string): void {
  const cols: (keyof Lead)[] = [
    "name", "phone", "email", "website", "category",
    "address1", "address2", "region", "zip", "country",
    "googlestars", "googlecount", "yelpstars", "yelpcount",
    "fbstars", "fbcount", "ig_followers",
  ];

  const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;

  const lines = [
    cols.join(","),
    ...leads.map((lead) => cols.map((c) => escape(lead[c])).join(",")),
  ];

  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function printTable(leads: Lead[]): void {
  const cols = [
    "name",
    "phone",
    "email",
    "website",
    "address1",
    "region",
    "zip",
    "googlestars",
  ] as const;

  type Col = (typeof cols)[number];
  const rows = leads as unknown as Record<Col, string>[];

  // Column widths
  const widths: Record<string, number> = {};
  for (const col of cols) widths[col] = col.length;
  for (const lead of rows) {
    for (const col of cols) {
      widths[col] = Math.max(widths[col], (lead[col] ?? "").length);
    }
  }

  const hr = cols.map((c) => "-".repeat(widths[c] + 2)).join("+");
  const row = (vals: Record<string, string>) =>
    cols.map((c) => ` ${(vals[c] ?? "").padEnd(widths[c])} `).join("|");

  const header: Record<string, string> = {};
  for (const c of cols) header[c] = c;

  console.log(hr);
  console.log(row(header));
  console.log(hr);
  for (const lead of rows) {
    console.log(row(lead));
  }
  console.log(hr);
}
