/**
 * `web_search`: pablo's own web search, behind a pluggable backend (D-11).
 *
 * The config file's `web.search` block names a backend. SearXNG (self-hosted,
 * no API key) is the first; another backend is a plain adapter implementing
 * `SearchBackend`. Network access goes through an injected `fetch`, so tests
 * never touch a real server.
 *
 * ```json
 * { "web": { "search": { "backend": "searxng", "url": "http://127.0.0.1:8080" } } }
 * ```
 */

import { ProviderConfigError } from "../providers/errors";

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}

export interface SearchOptions {
  /** Most results to return; a backend may return fewer. */
  readonly limit?: number;
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

/** A search backend: a query in, ranked `{title, url, snippet}` out. */
export interface SearchBackend {
  readonly name: string;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}

export const SEARCH_BACKENDS = ["searxng"] as const;
export type SearchBackendName = (typeof SEARCH_BACKENDS)[number];

/** The `web.search` config block. */
export interface WebSearchConfig {
  readonly backend: SearchBackendName;
  /** Base URL of the backend, no trailing slash. */
  readonly url: string;
  readonly timeoutMs: number;
}

/** The `web` config block. */
export interface WebConfig {
  readonly search?: WebSearchConfig;
}

export const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;
export const DEFAULT_SEARCH_LIMIT = 10;

/** Raised by `web_search` itself (no backend, backend unreachable or malformed); the message is user-facing. */
export class WebSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSearchError";
  }
}

export const NO_BACKEND_MESSAGE =
  'pablo: web_search: no search backend configured. Add a "web": { "search": { "backend": "searxng", "url": "<base url>" } } block to the config file.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads the `web` config key. Absent means no web config; mistakes are named. */
export function readWebConfig(value: unknown, source: string): WebConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new ProviderConfigError(`pablo: ${source}: "web" must be an object`);
  const rawSearch = value["search"];
  if (rawSearch === undefined) return {};
  const where = `${source}: "web.search"`;
  if (!isRecord(rawSearch)) throw new ProviderConfigError(`pablo: ${where} must be an object`);

  const backend = rawSearch["backend"];
  if (typeof backend !== "string" || !(SEARCH_BACKENDS as readonly string[]).includes(backend)) {
    throw new ProviderConfigError(`pablo: ${where}: "backend" must be one of ${SEARCH_BACKENDS.join(", ")}`);
  }
  const rawUrl = rawSearch["url"];
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new ProviderConfigError(`pablo: ${where}: "url" must be a non-empty string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ProviderConfigError(`pablo: ${where}: "url" is not a URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProviderConfigError(`pablo: ${where}: "url" must be http or https, not ${parsed.protocol}`);
  }
  const rawTimeout = rawSearch["timeoutMs"];
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isFinite(rawTimeout) || rawTimeout <= 0)) {
    throw new ProviderConfigError(`pablo: ${where}: "timeoutMs" must be a positive number`);
  }
  return {
    search: {
      backend: backend as SearchBackendName,
      url: rawUrl.replace(/\/+$/, ""),
      timeoutMs: (rawTimeout as number | undefined) ?? DEFAULT_SEARCH_TIMEOUT_MS,
    },
  };
}

/** SearXNG: `GET <base>/search?q=...&format=json`. The instance must have the json format enabled. */
export function searxngBackend(config: WebSearchConfig, fetchImpl: FetchLike = fetch as unknown as FetchLike): SearchBackend {
  return {
    name: "searxng",
    async search(query, options = {}) {
      const url = `${config.url}/search?${new URLSearchParams({ q: query, format: "json" }).toString()}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.timeoutMs);
      let body: unknown;
      try {
        const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) {
          const hint = response.status === 403 ? ' (is "json" listed under search.formats in the SearXNG settings?)' : "";
          throw new WebSearchError(`pablo: web_search: searxng at ${config.url} answered ${response.status}${hint}`);
        }
        body = await response.json();
      } catch (error) {
        if (error instanceof WebSearchError) throw error;
        const reason = controller.signal.aborted ? `no answer within ${config.timeoutMs}ms` : (error as Error).message;
        throw new WebSearchError(`pablo: web_search: could not reach searxng at ${config.url} (${reason})`);
      } finally {
        clearTimeout(timer);
      }
      if (!isRecord(body) || !Array.isArray(body["results"])) {
        throw new WebSearchError(`pablo: web_search: searxng at ${config.url} returned no "results" list`);
      }
      const results: SearchResult[] = [];
      for (const item of body["results"]) {
        if (!isRecord(item)) continue;
        const itemUrl = item["url"];
        if (typeof itemUrl !== "string" || itemUrl === "") continue;
        results.push({
          title: typeof item["title"] === "string" ? item["title"] : itemUrl,
          url: itemUrl,
          snippet: typeof item["content"] === "string" ? item["content"] : "",
        });
      }
      return results.slice(0, options.limit ?? DEFAULT_SEARCH_LIMIT);
    },
  };
}

/** The backend a config names, or undefined when none is configured. */
export function createSearchBackend(config: WebConfig | undefined, fetchImpl?: FetchLike): SearchBackend | undefined {
  const search = config?.search;
  if (search === undefined) return undefined;
  switch (search.backend) {
    case "searxng":
      return searxngBackend(search, fetchImpl);
  }
}

export interface WebSearchOptions extends SearchOptions {
  readonly config?: WebConfig;
  /** The backend to use instead of building one from `config` (tests, future adapters). */
  readonly backend?: SearchBackend;
  readonly fetch?: FetchLike;
}

/** `web_search`: runs the query on the configured backend. Throws `WebSearchError` when none is configured. */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<SearchResult[]> {
  if (query.trim() === "") throw new WebSearchError("pablo: web_search: the query is empty");
  const backend = options.backend ?? createSearchBackend(options.config, options.fetch);
  if (backend === undefined) throw new WebSearchError(NO_BACKEND_MESSAGE);
  return backend.search(query, options.limit === undefined ? {} : { limit: options.limit });
}
