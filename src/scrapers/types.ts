/** Thrown when the queue should pause and re-queue the current job. */
export class PauseError extends Error {
  constructor(reason: string) { super(reason); this.name = "PauseError"; }
}

/** Thrown when the user manually stops the queue. */
export class StoppedError extends Error {
  constructor() { super("Stopped by user"); this.name = "StoppedError"; }
}

export interface UniversalLead {
  name: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  category: string;
  googleStars: string;
  googleCount: string;
  yelpStars: string;
  yelpCount: string;
  fbStars: string;
  fbCount: string;
  [key: string]: string;
}

export interface SearchJob {
  id: string;
  keywords: string[];
  location: string;
  country: string;
  scraperId: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  results: UniversalLead[];
  resultCount: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface AccountSummary {
  dailyLimit: number | string;
  usedToday: number;
  remaining: number;
  resetsInSeconds: number;
}

export interface IScraper {
  id: string;
  name: string;
  search(keywords: string[], location: string, country: string): Promise<UniversalLead[]>;
  getAccount?(): Promise<AccountSummary>;
}
