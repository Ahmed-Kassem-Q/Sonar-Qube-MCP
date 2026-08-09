/**
 * SonarQube / SonarCloud Web API client.
 *
 * Design goals:
 *
 * - **Single source of truth for HTTP concerns** — auth, timeouts, retries,
 *   pagination, and error mapping all live here so `tools.ts` and
 *   `resources.ts` stay thin and declarative.
 * - **Predictable error handling** — every failure mode becomes a typed error
 *   from `errors.ts` with a clear, actionable message, and the `retryable` flag
 *   drives a single retry policy.
 * - **Testable** — the `fetch` implementation is injectable, so tests drive the
 *   client against a stub instead of a live server.
 */

import { isRetryable } from './errors.js';
import {
  SonarQubeAPIError,
  SonarQubeAuthenticationError,
  SonarQubeConnectionError,
  SonarQubeNotFoundError,
  SonarQubeRateLimitError,
  SonarQubeTimeoutError,
} from './errors.js';
import type { Settings } from './config.js';
import { getLogger } from './logging.js';
import {
  issuesPageSchema,
  projectMetricsSchema,
  projectsPageSchema,
  qualityGateResultSchema,
  type Issue,
  type IssuesPage,
  type Project,
  type ProjectMetrics,
  type ProjectsPage,
  type QualityGateResult,
  type Severity,
} from './models.js';

const logger = getLogger('sonarqube-mcp.client');

/**
 * Safety valve so a pagination bug (or a server that never reports a sane
 * `total`) can never spin forever.
 */
const MAX_PAGES = 1000;

/** Longest single backoff sleep, in seconds. */
const MAX_BACKOFF_SECONDS = 30;

/** The subset of `fetch` this client relies on; lets tests inject a stub. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type QueryValue = string | number | boolean | null | undefined;

function sleep(seconds: number): Promise<void> {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((done) => setTimeout(done, seconds * 1000));
}

export interface IssueFilters {
  severities?: readonly Severity[] | undefined;
  types?: readonly string[] | undefined;
  statuses?: readonly string[] | undefined;
}

/** Thin, typed wrapper around the SonarQube/SonarCloud Web API. */
export class SonarQubeClient {
  readonly #settings: Settings;
  readonly #fetch: FetchLike;
  readonly #authHeader: string | null;

  constructor(settings: Settings, fetchImpl: FetchLike = fetch) {
    this.#settings = settings;
    this.#fetch = fetchImpl;

    const auth = settings.auth;
    this.#authHeader = auth
      ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf-8').toString('base64')}`
      : null;
  }

  /**
   * Release any resources held by the client.
   *
   * `fetch` keeps no client-owned pool to tear down, so this is a no-op that
   * exists to keep the server's shutdown path explicit and to give tests and
   * future transports a hook.
   */
  async close(): Promise<void> {
    /* no persistent pool to close */
  }

  // -- low-level request plumbing --------------------------------------------

  #withOrg(params: Record<string, QueryValue>): Record<string, QueryValue> {
    const org = this.#settings.sonarqubeOrganization;
    if (org && params['organization'] === undefined) {
      return { ...params, organization: org };
    }
    return params;
  }

  #buildUrl(path: string, params: Record<string, QueryValue>): string {
    const url = new URL(path, `${this.#settings.sonarqubeUrl}/`);
    for (const [key, value] of Object.entries(params)) {
      if (value === null || value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  async #doRequest(
    method: string,
    path: string,
    params: Record<string, QueryValue>,
  ): Promise<unknown> {
    const url = this.#buildUrl(path, params);
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.#authHeader) headers['Authorization'] = this.#authHeader;

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        signal: AbortSignal.timeout(this.#settings.requestTimeoutSeconds * 1000),
      });
    } catch (error) {
      const err = error as Error;
      // AbortSignal.timeout() rejects with a TimeoutError DOMException.
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new SonarQubeTimeoutError(
          `Request to ${path} timed out after ${this.#settings.requestTimeoutSeconds}s: ${err.message}`,
        );
      }
      throw new SonarQubeConnectionError(
        `Could not reach SonarQube host ${this.#settings.sonarqubeUrl}: ${err.message}`,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new SonarQubeAuthenticationError(
        `SonarQube rejected the request to ${path} with HTTP ${response.status}. ` +
          'Check SONARQUBE_TOKEN / SONARQUBE_USERNAME/SONARQUBE_PASSWORD and that ' +
          'the credential has permission to access this resource.',
      );
    }
    if (response.status === 404) {
      throw new SonarQubeNotFoundError(
        `Resource not found: ${path} (params=${JSON.stringify(params)})`,
      );
    }
    if (response.status === 429) {
      const header = response.headers.get('Retry-After');
      const retryAfter = header !== null && header !== '' ? Number(header) : null;
      throw new SonarQubeRateLimitError(
        `SonarQube rate-limited the request to ${path}.`,
        retryAfter !== null && Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    if (response.status >= 500) {
      const body = await response.text().catch(() => '');
      throw new SonarQubeAPIError(`SonarQube returned HTTP ${response.status} for ${path}.`, {
        statusCode: response.status,
        retryable: true,
        responseBody: body.slice(0, 2000),
      });
    }
    if (response.status >= 400) {
      const body = await response.text().catch(() => '');
      throw new SonarQubeAPIError(
        `SonarQube rejected the request to ${path} with HTTP ${response.status}: ${body.slice(0, 500)}`,
        { statusCode: response.status, retryable: false, responseBody: body.slice(0, 2000) },
      );
    }

    const text = await response.text();
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new SonarQubeAPIError(`SonarQube returned a non-JSON response for ${path}.`, {
        statusCode: response.status,
        retryable: false,
        responseBody: text.slice(0, 2000),
      });
    }
  }

  /** Issue an HTTP request with the configured retry policy applied. */
  async #request(
    method: string,
    path: string,
    params: Record<string, QueryValue> = {},
  ): Promise<unknown> {
    const attempts = Math.max(1, this.#settings.maxRetries + 1);

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.#doRequest(method, path, params);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === attempts) throw error;

        // Exponential backoff, clamped — mirrors tenacity's wait_exponential.
        const backoff = Math.min(
          this.#settings.retryBackoffSeconds * 2 ** (attempt - 1),
          MAX_BACKOFF_SECONDS,
        );
        const retryAfter =
          error instanceof SonarQubeRateLimitError && error.retryAfter !== null
            ? error.retryAfter
            : null;
        const delay = Math.min(retryAfter ?? backoff, MAX_BACKOFF_SECONDS);
        logger.debug(
          `${path} failed (attempt ${attempt}/${attempts}), retrying in ${delay}s: ${(error as Error).message}`,
        );
        await sleep(delay);
      }
    }
    throw lastError;
  }

  // -- projects ---------------------------------------------------------------

  /**
   * Call `GET /api/components/search` for a single page of projects.
   *
   * Deliberately *not* `api/projects/search`: that endpoint requires the global
   * "Administer System" permission and returns HTTP 403 for ordinary users.
   * `api/components/search` filtered to `qualifiers=TRK` lists the projects the
   * credential can browse, needs no admin rights, and returns the same
   * `paging`/`components` envelope.
   */
  async searchProjects(
    options: { query?: string | undefined; page?: number; pageSize?: number } = {},
  ): Promise<ProjectsPage> {
    const params = this.#withOrg({
      qualifiers: 'TRK',
      p: options.page ?? 1,
      ps: options.pageSize ?? this.#settings.defaultPageSize,
      q: options.query ?? null,
    });
    const data = await this.#request('GET', '/api/components/search', params);
    return projectsPageSchema.parse(data);
  }

  /** Fetch every project visible to the configured credentials, paginating. */
  async getAllProjects(options: { query?: string | undefined } = {}): Promise<Project[]> {
    const projects: Project[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.searchProjects({ query: options.query, page });
      projects.push(...result.components);
      const fetched = result.paging.pageIndex * result.paging.pageSize;
      if (result.components.length === 0 || fetched >= result.paging.total) break;
    }
    return projects;
  }

  // -- issues ------------------------------------------------------------------

  /** Call `GET /api/issues/search` for a single page of results. */
  async searchIssues(
    projectKey: string,
    options: IssueFilters & { page?: number; pageSize?: number } = {},
  ): Promise<IssuesPage> {
    const params = this.#withOrg({
      componentKeys: projectKey,
      severities: options.severities?.length ? options.severities.join(',') : null,
      types: options.types?.length ? options.types.join(',') : null,
      statuses: options.statuses?.length ? options.statuses.join(',') : null,
      p: options.page ?? 1,
      ps: options.pageSize ?? this.#settings.defaultPageSize,
    });
    const data = await this.#request('GET', '/api/issues/search', params);
    return issuesPageSchema.parse(data);
  }

  /** Fetch issues for a project, paginating until exhausted or `maxResults`. */
  async getAllIssues(
    projectKey: string,
    options: IssueFilters & { maxResults?: number | undefined } = {},
  ): Promise<Issue[]> {
    const issues: Issue[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.searchIssues(projectKey, { ...options, page });
      issues.push(...result.issues);
      if (options.maxResults !== undefined && issues.length >= options.maxResults) {
        return issues.slice(0, options.maxResults);
      }
      const fetched = result.paging.pageIndex * result.paging.pageSize;
      if (result.issues.length === 0 || fetched >= result.paging.total) break;
    }
    return issues;
  }

  /**
   * Fetch a single issue by key via `api/issues/search?issues=<key>`.
   *
   * SonarQube has no dedicated "get issue by key" endpoint in modern versions,
   * so we filter `issues/search` down to one key instead.
   */
  async getIssue(issueKey: string): Promise<Issue> {
    const params = this.#withOrg({ issues: issueKey, additionalFields: '_all', ps: 1 });
    const data = await this.#request('GET', '/api/issues/search', params);
    const page = issuesPageSchema.parse(data);
    const issue = page.issues[0];
    if (issue === undefined) {
      throw new SonarQubeNotFoundError(`No issue found with key '${issueKey}'.`);
    }
    return issue;
  }

  // -- quality gate --------------------------------------------------------------

  /** Call `GET /api/qualitygates/project_status`. */
  async getQualityGateStatus(projectKey: string): Promise<QualityGateResult> {
    const params = this.#withOrg({ projectKey });
    const data = await this.#request('GET', '/api/qualitygates/project_status', params);

    const projectStatus = (data as Record<string, unknown> | null)?.['projectStatus'];
    if (projectStatus === undefined) {
      throw new SonarQubeAPIError(
        "Unexpected response shape from api/qualitygates/project_status (missing 'projectStatus'): " +
          JSON.stringify(data),
        { statusCode: 200, retryable: false },
      );
    }
    return qualityGateResultSchema.parse(projectStatus);
  }

  // -- metrics ------------------------------------------------------------------

  /** Call `GET /api/measures/component` for the given metric keys. */
  async getMeasures(projectKey: string, metricKeys: readonly string[]): Promise<ProjectMetrics> {
    const params = this.#withOrg({ component: projectKey, metricKeys: metricKeys.join(',') });
    const data = await this.#request('GET', '/api/measures/component', params);

    const component = (data as Record<string, unknown> | null)?.['component'];
    if (component === undefined) {
      throw new SonarQubeAPIError(
        "Unexpected response shape from api/measures/component (missing 'component'): " +
          JSON.stringify(data),
        { statusCode: 200, retryable: false },
      );
    }
    return projectMetricsSchema.parse(component);
  }
}
