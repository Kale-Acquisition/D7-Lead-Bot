export interface SearchResponse {
  searchid: number;
  wait_seconds: string;
}

export interface Lead {
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

export interface AccountInfo {
  daily_limit: string;
  used_today: number;
  today_remaining: number;
  seconds_to_reset: number;
}

export interface SearchHistoryEntry {
  city: string;
  state: string;
  country: string;
  keyword: string;
  searchid: string;
  date: string;
}

export interface ApiError {
  error: string;
}
