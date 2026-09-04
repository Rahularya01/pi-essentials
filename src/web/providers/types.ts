export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface SearchResult {
  provider: string;
  query: string;
  hits: SearchHit[];
  notes?: string;
}

export type SearchFn = (query: string, count: number, signal: AbortSignal) => Promise<SearchResult>;
