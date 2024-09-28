export type Bindings = {
  URL_SHORTENER: KVNamespace;
  URL_CLICK_TRACKING: AnalyticsEngineDataset;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  THE_GITHUB_USERNAME: string;
  ACCOUNT_ID: string;
  API_TOKEN: string;
};

export type ShortenRequest = {
  originalUrl: string;
  shortCode?: string;
  expiration?: number; // Unix timestamp
  description?: string;
};

export type ShortenResponse = {
  shortUrl: string;
  originalUrl?: string;
  success?: boolean;
  message?: string; // used for error
};

export type KVData = {
  originalUrl: string;
  expiration?: number; // Unix timestamp
  description?: string;
  urlId: string;
};

export type KVPair = {
  shortCode: string;
  originalUrl: string;
  urlId: string;
  expiration?: number; // Unix timestamp
  description?: string;
};

export type ListAllResponse = {
  success: boolean;
  message?: string;
  data?: KVPair[];
};

export type ClickData = {
  date: string;
  count: number;
};

export type AnalyticsResponseType = {
  success: boolean;
  message?: string;
  urlId?: string;
  originalUrl?: string;
  shortCodes?: {
    [shortCode: string]: ClickData[];
  };
  totalClicks?: number;
};

export type AnalyticsEngineResponseType = {
  meta: { name: string; type: string }[];
  data: {
    originalUrl: string;
    shortCode: string;
    date: string;
    count: string;
  }[];
  rows: number;
};

export interface AnalyticsRequestBody {
  originalUrl: string;
  startDateTimestamp: number;
  endDateTimestamp: number;
}

export interface AnalyticsOverviewData {
  totalClicks: number;
  totalLinks: number;
  avgClicksPerLink: number;
}

export interface AnalyticsOverviewResponse {
  success: boolean;
  data?: AnalyticsOverviewData;
  message?: string;
}