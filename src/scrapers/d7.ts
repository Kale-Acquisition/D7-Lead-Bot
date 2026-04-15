import axios, { AxiosInstance } from "axios";
import { IScraper, UniversalLead, AccountSummary, PauseError } from "./types";

// ── Raw D7 API shapes ────────────────────────────────────────────────────────

interface D7SearchResponse {
  searchid: number;
  wait_seconds: string;
}

interface D7Lead {
  name: string;
  phone: string;
  website: string;
  email: string;
  category: string;
  address1: string;
  address2: string;
  region: string;
  zip: string;
  country: string;
  googlestars: string;
  googlecount: string;
  yelpstars: string;
  yelpcount: string;
  fbstars: string;
  fbcount: string;
  ig_followers: string;
}

interface D7AccountInfo {
  daily_limit: string;
  used_today: number;
  today_remaining: number;
  seconds_to_reset: number;
}

interface D7ApiError {
  error: string;
}

function isApiError(data: unknown): data is D7ApiError {
  return typeof data === "object" && data !== null && "error" in data;
}

// ── D7 Scraper ───────────────────────────────────────────────────────────────

export class D7Scraper implements IScraper {
  readonly id = "d7";
  readonly name = "D7 Lead Finder";
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: "https://dash.d7leadfinder.com/app/api/",
      params: { key: apiKey },
    });
  }

  async search(keywords: string[], location: string, country = "US"): Promise<UniversalLead[]> {
    const allResults: UniversalLead[] = [];

    for (const keyword of keywords) {
      try {
        // 1. Start the search for this keyword
        const { data: startData } = await this.http.post<D7SearchResponse | D7ApiError>(
          "search/",
          null,
          { params: { keyword, location, country } }
        );
        if (isApiError(startData)) throw new PauseError(`D7 API error (${keyword}): ${startData.error}`);

        // 2. Wait the required delay
        const delaySecs = parseInt(startData.wait_seconds, 10);
        await new Promise((res) => setTimeout(res, delaySecs * 1000));

        // 3. Fetch results
        const { data: raw } = await this.http.get<D7Lead[] | D7ApiError>("/results/", {
          params: { id: startData.searchid },
        });
        if (isApiError(raw)) throw new PauseError(`D7 API error (${keyword}): ${raw.error}`);

        const mapped = raw.map((lead): UniversalLead => ({
          name: lead.name ?? "",
          phone: lead.phone ?? "",
          email: lead.email ?? "",
          website: lead.website ?? "",
          address: [lead.address1, lead.address2, lead.region, lead.zip, lead.country]
            .filter(Boolean)
            .join(", "),
          category: lead.category ?? "",
          googleStars: lead.googlestars ?? "",
          googleCount: lead.googlecount ?? "",
          yelpStars: lead.yelpstars ?? "",
          yelpCount: lead.yelpcount ?? "",
          fbStars: lead.fbstars ?? "",
          fbCount: lead.fbcount ?? "",
        }));

        allResults.push(...mapped);

      } catch (err) {
        if (err instanceof PauseError) throw err; // already wrapped, bubble up
        // Network error, timeout, or anything unexpected — pause the queue
        const msg = err instanceof Error ? err.message : String(err);
        throw new PauseError(`Network/unexpected error (${keyword}): ${msg}`);
      }
    }

    return allResults;
  }

  async getAccount(): Promise<AccountSummary> {
    const { data } = await this.http.get<D7AccountInfo | D7ApiError>("/account/");
    if (isApiError(data)) throw new Error(`D7 API error: ${data.error}`);
    return {
      dailyLimit: data.daily_limit,
      usedToday: data.used_today,
      remaining: data.today_remaining,
      resetsInSeconds: data.seconds_to_reset,
    };
  }
}
