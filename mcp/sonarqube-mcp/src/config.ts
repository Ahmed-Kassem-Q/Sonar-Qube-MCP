/**
 * Typed, validated configuration for sonarqube-mcp.
 *
 * All configuration comes from environment variables, optionally seeded from a
 * local `.env` file resolved against the current working directory. See
 * `.env.example` for the full list of supported variables and their defaults.
 *
 * Configuration is resolved once via {@link getSettings}, which memoizes the
 * validated result so every part of the server shares one instance. Tests call
 * {@link clearSettingsCache} to force re-evaluation after mutating the
 * environment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { ConfigurationError } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logging.js';

/**
 * Directories searched for a `.env` file, in order.
 *
 * The package's own directory is included so that `mcp/sonarqube-mcp/.env`
 * works when Claude Code launches the server from the project root. Without
 * it, `.env` would only ever apply when running the server by hand from inside
 * the package — a trap that reliably confuses new developers, since the file
 * sits right next to `.env.example` and looks like it should work.
 *
 * The current working directory is searched first so a project-level `.env` can
 * override the package default.
 */
function dotEnvSearchPaths(): string[] {
  // dist/config.js -> dist -> package root
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return [resolve(process.cwd(), '.env'), resolve(packageRoot, '.env')];
}

/**
 * Seed `process.env` from the first `.env` file found, without clobbering
 * variables that are already set.
 *
 * Real environment variables deliberately win over `.env` entries, so a value
 * in `.mcp.json`'s `env` block or exported in the shell always takes
 * precedence over the file.
 */
function loadDotEnv(): void {
  // Tests set this so a developer's real .env cannot leak live credentials
  // into cases that deliberately unset them.
  if (process.env['MCP_SKIP_DOTENV'] === '1') return;

  const envPath = dotEnvSearchPaths().find((candidate) => existsSync(candidate));
  if (envPath === undefined) return;

  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    return; // unreadable .env is not fatal — real env vars may still suffice
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || key in process.env) continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes, if present.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** Expand a leading `~` and resolve to an absolute path. */
function expandUserPath(value: string): string {
  const expanded = value.startsWith('~') ? value.replace(/^~/, homedir()) : value;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(process.cwd(), expanded);
}

/** Parse an environment variable as a boolean, accepting the usual spellings. */
const booleanFromEnv = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => ['true', '1', 'yes', 'on', 'false', '0', 'no', 'off'].includes(value), {
    message: 'must be a boolean (true/false)',
  })
  .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

/** Parse an environment variable as a number within optional bounds. */
function numberFromEnv(constraints: { min?: number; max?: number; exclusiveMin?: number }) {
  return z
    .string()
    .transform((value, ctx) => {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        ctx.addIssue({ code: 'custom', message: `must be a number, got ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return parsed;
    })
    .refine((n) => constraints.exclusiveMin === undefined || n > constraints.exclusiveMin, {
      message: `must be greater than ${constraints.exclusiveMin}`,
    })
    .refine((n) => constraints.min === undefined || n >= constraints.min, {
      message: `must be >= ${constraints.min}`,
    })
    .refine((n) => constraints.max === undefined || n <= constraints.max, {
      message: `must be <= ${constraints.max}`,
    });
}

const settingsSchema = z
  .object({
    // --- SonarQube / SonarCloud connection ---------------------------------
    SONARQUBE_URL: z
      .string()
      .transform((value) => value.trim())
      .refine((value) => value.length > 0, { message: 'SONARQUBE_URL must not be empty' })
      .transform((value) => value.replace(/\/+$/, '')),
    SONARQUBE_TOKEN: z.string().optional(),
    SONARQUBE_USERNAME: z.string().optional(),
    SONARQUBE_PASSWORD: z.string().optional(),
    SONARQUBE_ORGANIZATION: z.string().optional(),

    // --- HTTP client behavior ----------------------------------------------
    SONARQUBE_TIMEOUT_SECONDS: numberFromEnv({ exclusiveMin: 0 }).default(30),
    SONARQUBE_MAX_RETRIES: numberFromEnv({ min: 0, max: 10 }).default(3),
    SONARQUBE_RETRY_BACKOFF_SECONDS: numberFromEnv({ min: 0 }).default(0.5),
    SONARQUBE_PAGE_SIZE: numberFromEnv({ min: 1, max: 500 }).default(100),
    SONARQUBE_VERIFY_SSL: booleanFromEnv.default(true),

    // --- Repository access tools --------------------------------------------
    MCP_REPO_ROOT: z.string().default('.').transform(expandUserPath),
    MCP_MAX_READ_FILE_BYTES: numberFromEnv({ exclusiveMin: 0 }).default(2_000_000),
    MCP_MAX_WRITE_FILE_BYTES: numberFromEnv({ exclusiveMin: 0 }).default(2_000_000),

    // --- Logging --------------------------------------------------------------
    MCP_LOG_LEVEL: z
      .string()
      .default('INFO')
      .transform((value) => value.trim().toUpperCase())
      .refine((value): value is LogLevel => (LOG_LEVELS as readonly string[]).includes(value), {
        message: `MCP_LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`,
      }),
  })
  .superRefine((raw, ctx) => {
    const hasToken = Boolean(raw.SONARQUBE_TOKEN?.trim());
    const hasBasicAuth = Boolean(raw.SONARQUBE_USERNAME) && raw.SONARQUBE_PASSWORD !== undefined;
    if (!hasToken && !hasBasicAuth) {
      ctx.addIssue({
        code: 'custom',
        message:
          'No SonarQube credentials configured. Set SONARQUBE_TOKEN (recommended) ' +
          'or both SONARQUBE_USERNAME and SONARQUBE_PASSWORD.',
      });
    }
  });

/** HTTP Basic credentials: SonarQube accepts a token as the username. */
export interface BasicAuth {
  username: string;
  password: string;
}

export interface Settings {
  readonly sonarqubeUrl: string;
  readonly sonarqubeToken: string | undefined;
  readonly sonarqubeUsername: string | undefined;
  readonly sonarqubePassword: string | undefined;
  readonly sonarqubeOrganization: string | undefined;
  readonly requestTimeoutSeconds: number;
  readonly maxRetries: number;
  readonly retryBackoffSeconds: number;
  readonly defaultPageSize: number;
  readonly verifySsl: boolean;
  readonly repoRoot: string;
  readonly maxReadFileBytes: number;
  readonly maxWriteFileBytes: number;
  readonly logLevel: LogLevel;
  /**
   * Credentials for HTTP Basic auth, or null if none are configured.
   *
   * SonarQube/SonarCloud accept an API token as the Basic-auth username with an
   * empty password — this works across all supported server versions, unlike
   * the newer Bearer-token scheme.
   */
  readonly auth: BasicAuth | null;
}

/**
 * Build a {@link Settings} object from an environment mapping.
 *
 * Exported for tests; production code should call {@link getSettings}.
 *
 * @throws {ConfigurationError} if a required variable is missing or invalid.
 */
export function buildSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  // Drop empty strings so they fall through to defaults rather than failing
  // validation — `SONARQUBE_ORGANIZATION=` in a .env file is a common way to
  // say "not applicable".
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }

  const parsed = settingsSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigurationError(
      'Invalid or missing sonarqube-mcp configuration. Check your .env file or ' +
        `environment variables against .env.example. Details: ${details}`,
    );
  }

  const raw = parsed.data;
  const token = raw.SONARQUBE_TOKEN?.trim();

  let auth: BasicAuth | null = null;
  if (token) {
    auth = { username: token, password: '' };
  } else if (raw.SONARQUBE_USERNAME && raw.SONARQUBE_PASSWORD !== undefined) {
    auth = { username: raw.SONARQUBE_USERNAME, password: raw.SONARQUBE_PASSWORD };
  }

  return {
    sonarqubeUrl: raw.SONARQUBE_URL,
    sonarqubeToken: raw.SONARQUBE_TOKEN,
    sonarqubeUsername: raw.SONARQUBE_USERNAME,
    sonarqubePassword: raw.SONARQUBE_PASSWORD,
    sonarqubeOrganization: raw.SONARQUBE_ORGANIZATION,
    requestTimeoutSeconds: raw.SONARQUBE_TIMEOUT_SECONDS,
    maxRetries: raw.SONARQUBE_MAX_RETRIES,
    retryBackoffSeconds: raw.SONARQUBE_RETRY_BACKOFF_SECONDS,
    defaultPageSize: raw.SONARQUBE_PAGE_SIZE,
    verifySsl: raw.SONARQUBE_VERIFY_SSL,
    repoRoot: raw.MCP_REPO_ROOT,
    maxReadFileBytes: raw.MCP_MAX_READ_FILE_BYTES,
    maxWriteFileBytes: raw.MCP_MAX_WRITE_FILE_BYTES,
    logLevel: raw.MCP_LOG_LEVEL,
    auth,
  };
}

let cached: Settings | null = null;

/**
 * Return the memoized, validated settings singleton.
 *
 * @throws {ConfigurationError} if configuration is missing or invalid.
 */
export function getSettings(): Settings {
  if (cached === null) {
    loadDotEnv();
    cached = buildSettings();
  }
  return cached;
}

/** Discard the memoized settings. Tests use this after mutating the env. */
export function clearSettingsCache(): void {
  cached = null;
}
