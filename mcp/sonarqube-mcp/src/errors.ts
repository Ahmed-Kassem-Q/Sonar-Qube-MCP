/**
 * Error hierarchy for the sonarqube-mcp server.
 *
 * Every error thrown by this package extends {@link SonarQubeMCPError}, so
 * callers (and MCP tool handlers, which surface error messages directly to the
 * calling LLM) can catch a single base class when they don't need fine-grained
 * handling.
 *
 * Errors representing a transient failure (network blips, timeouts, HTTP
 * 429/5xx) carry a `retryable` flag so `client.ts` can implement a single,
 * consistent retry policy instead of scattering try/catch logic across call
 * sites.
 */

export class SonarQubeMCPError extends Error {
  /** Whether retrying the same request could plausibly succeed. */
  readonly retryable: boolean = false;

  constructor(message: string) {
    super(message);
    // Without this, `instanceof` breaks for subclasses when targeting ES5-era
    // output; harmless and explicit at any target.
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Thrown when required configuration is missing or invalid. */
export class ConfigurationError extends SonarQubeMCPError {}

/** Thrown when the SonarQube/SonarCloud host could not be reached. */
export class SonarQubeConnectionError extends SonarQubeMCPError {
  override readonly retryable = true;
}

/** Thrown when a request to SonarQube exceeded the configured timeout. */
export class SonarQubeTimeoutError extends SonarQubeMCPError {
  override readonly retryable = true;
}

/** Thrown on HTTP 401/403 — invalid token, credentials, or permissions. */
export class SonarQubeAuthenticationError extends SonarQubeMCPError {
  override readonly retryable = false;
}

/** Thrown when a project, issue, or resource does not exist (HTTP 404). */
export class SonarQubeNotFoundError extends SonarQubeMCPError {
  override readonly retryable = false;
}

/** Thrown on HTTP 429. Retryable with backoff. */
export class SonarQubeRateLimitError extends SonarQubeMCPError {
  override readonly retryable = true;
  readonly retryAfter: number | null;

  constructor(message: string, retryAfter: number | null = null) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/**
 * Thrown for any other non-2xx SonarQube API response.
 *
 * `retryable` is set from the HTTP status code (5xx is retried; other 4xx codes
 * are not, since retrying a malformed request only reproduces the same error).
 */
export class SonarQubeAPIError extends SonarQubeMCPError {
  override readonly retryable: boolean;
  readonly statusCode: number;
  readonly responseBody: string | null;

  constructor(
    message: string,
    options: { statusCode: number; retryable?: boolean; responseBody?: string | null },
  ) {
    super(message);
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
    this.responseBody = options.responseBody ?? null;
  }
}

/**
 * Thrown by the repository access tools (read_file, write_file, ...).
 *
 * Covers path-traversal attempts, missing files, size-limit violations, and the
 * "write without confirmation" safety gate.
 */
export class RepositoryAccessError extends SonarQubeMCPError {
  override readonly retryable = false;
}

/** True when an unknown thrown value is a retryable {@link SonarQubeMCPError}. */
export function isRetryable(error: unknown): boolean {
  return error instanceof SonarQubeMCPError && error.retryable;
}
