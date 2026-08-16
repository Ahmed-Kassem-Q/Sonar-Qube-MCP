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
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { ConfigurationError } from './errors.js';
import { LOG_LEVELS, type LogLevel } from './logging.js';

/**
 * Locations searched for `.env` files, most specific first.
 *
 * 1. **Working directory** — the project root when Claude Code launches the
 *    server, so a single project can override the global config.
 * 2. **The package's own directory** — makes `mcp/sonarqube-mcp/.env` work when
 *    running from a clone of this repository. Without it, `.env` would only
 *    apply when running the server by hand from inside the package, a trap that
 *    reads as broken since the file sits right next to `.env.example`.
 * 3. **`~/.config/sonarqube-mcp/.env`** — the global location, used when the
 *    server is installed as a plugin, where neither of the first two paths
 *    points anywhere a user would think to edit.
 *
 * Every existing file is applied, in this order, and an earlier file wins on a
 * per-key basis. They are *layered*, not chosen between: stopping at the first
 * file that exists would mean any project with an unrelated `.env` of its own —
 * which is most of them — shadowed the global config completely and the server
 * failed to start despite valid global credentials.
 */
export function dotEnvSearchPaths(): string[] {
  // dist/config.js -> dist -> package root
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  return [
    resolve(process.cwd(), '.env'),
    resolve(packageRoot, '.env'),
    globalEnvPath(),
  ];
}

/**
 * Path to the user-level config file, honouring `XDG_CONFIG_HOME` where set.
 *
 * Exported so the setup script writes to exactly the path the server reads.
 */
export function globalEnvPath(): string {
  const xdg = process.env['XDG_CONFIG_HOME'];
  const configHome = xdg && xdg.trim() !== '' ? xdg : join(homedir(), '.config');
  return resolve(configHome, 'sonarqube-mcp', '.env');
}

/**
 * Seed `process.env` from every `.env` file found, without clobbering variables
 * that are already set.
 *
 * Because nothing already set is overwritten, and files are applied in
 * most-specific-first order, an earlier file wins per key and real environment
 * variables win over all of them — so a value exported in the shell or passed
 * in `.mcp.json`'s `env` block always takes precedence.
 */
function loadDotEnv(): void {
  // Tests set this so a developer's real .env cannot leak live credentials
  // into cases that deliberately unset them.
  if (process.env['MCP_SKIP_DOTENV'] === '1') return;

  applyDotEnvFiles(dotEnvSearchPaths());
}

/**
 * Apply each existing file in `paths` to `env`, earlier files winning per key.
 *
 * Exported so the layering can be tested against fixture paths and a throwaway
 * environment, rather than through {@link getSettings}, whose result depends on
 * whichever `.env` files happen to exist on the machine running the tests.
 */
export function applyDotEnvFiles(
  paths: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const candidate of paths) {
    if (existsSync(candidate)) applyDotEnvFile(candidate, env);
  }
}

/**
 * Apply one `.env` file, leaving keys that are already set untouched.
 *
 * A variable set to an empty string counts as *unset* here. The plugin passes
 * every optional setting through `.mcp.json`'s `env` block as
 * `${user_config.…}`, and a field the user left blank interpolates to `""` — so
 * treating "present but empty" as configured would let a blank prompt field
 * shadow a perfectly good value in `.env`, which reads as the file being
 * ignored. This also matches {@link buildSettings}, which drops empty strings so
 * they fall through to defaults.
 */
function applyDotEnvFile(envPath: string, env: NodeJS.ProcessEnv): void {
  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    return; // unreadable .env is not fatal — other sources may still suffice
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!key || isConfigured(env[key])) continue;

    let value = trimmed.slice(eq + 1).trim();
    // Strip matching surrounding quotes, if present.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}

/**
 * A value that is set to something usable.
 *
 * Two shapes count as *unset* even though the variable exists:
 *
 * - **Empty string** — how a blank optional field arrives, and how `.env`
 *   files conventionally spell "not applicable".
 * - **An uninterpolated `${...}` placeholder** — when this server runs as a
 *   Claude Code plugin, `.mcp.json` passes configuration as `${user_config.…}`
 *   for the host to substitute. If substitution does not happen — an older
 *   Claude Code, a hand-written `.mcp.json`, a config key that does not match
 *   the `userConfig` declaration — the literal text arrives as the value.
 *   Accepting it means the server starts happily with a nonsense URL or token
 *   and fails later on every call with a connection or auth error that points
 *   nowhere near the real cause. Treating it as absent lets the `.env` files
 *   fill the gap, and produces the normal "no credentials configured" message
 *   when they cannot.
 */
function isConfigured(value: string | undefined): value is string {
  if (value === undefined) return false;
  const trimmed = value.trim();
  return trimmed !== '' && !/^\$\{[^}]*\}$/.test(trimmed);
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
  // Drop empty strings and uninterpolated `${...}` placeholders so they fall
  // through to defaults rather than failing validation — `SONARQUBE_ORGANIZATION=`
  // in a .env file is a common way to say "not applicable". See isConfigured.
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (isConfigured(value)) cleaned[key] = value;
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
