import axios, { AxiosInstance } from "axios";
import {
  AccountInfo,
  ApiError,
  Lead,
  SearchHistoryEntry,
  SearchResponse,
} from "./types";

const BASE_URL = "https://dash.d7leadfinder.com/app/api/";

function isApiError(data: unknown): data is ApiError {
  return typeof data === "object" && data !== null && "error" in data;
}

export class D7Client {
  private http: AxiosInstance;

  constructor(apiKey: string) {
    this.http = axios.create({
      baseURL: BASE_URL,
      // API key sent as query param on every request
      params: { key: apiKey },
    });
  }

  /**
   * Start a lead search. Returns a searchid and how many seconds to wait
   * before calling fetchResults().
   */
  async startSearch(
    keyword: string,
    city: string,
    country = "US"
  ): Promise<SearchResponse> {
    const { data } = await this.http.post<SearchResponse | ApiError>(
      "search/",
      null,
      { params: { keyword, location: city, country } }
    );

    if (isApiError(data)) {
      throw new Error(`D7 API error: ${data.error}`);
    }

    return data;
  }

  /**
   * Fetch results for a completed search.
   */
  async fetchResults(searchId: number): Promise<Lead[]> {
    const { data } = await this.http.get<Lead[] | ApiError>("/results/", {
      params: { id: searchId },
    });

    if (isApiError(data)) {
      throw new Error(`D7 API error: ${data.error}`);
    }

    return data;
  }

  /**
   * Full search: initiates the search, waits the required delay, then
   * returns the leads. Pass onWait to receive a callback before sleeping.
   */
  async search(
    keyword: string,
    city: string,
    country = "US",
    onWait?: (seconds: number) => void
  ): Promise<Lead[]> {
    const { searchid, wait_seconds } = await this.startSearch(
      keyword,
      city,
      country
    );

    const delay = parseInt(wait_seconds, 10) * 1000;
    if (onWait) onWait(parseInt(wait_seconds, 10));
    await new Promise((resolve) => setTimeout(resolve, delay));

    return this.fetchResults(searchid);
  }

  /** Check remaining daily quota. */
  async account(): Promise<AccountInfo> {
    const { data } = await this.http.get<AccountInfo | ApiError>("/account/");
    if (isApiError(data)) throw new Error(`D7 API error: ${data.error}`);
    return data;
  }

  /** Retrieve past search history (up to 500 entries). */
  async history(): Promise<SearchHistoryEntry[]> {
    const { data } = await this.http.get<SearchHistoryEntry[] | ApiError>(
      "/history/"
    );
    if (isApiError(data)) throw new Error(`D7 API error: ${data.error}`);
    return data;
  }

  /** Get keyword suggestions. */
  async keywords(): Promise<string[]> {
    const { data } = await this.http.get<string[] | ApiError>("/keywords/");
    if (isApiError(data)) throw new Error(`D7 API error: ${data.error}`);
    return data;
  }
}
