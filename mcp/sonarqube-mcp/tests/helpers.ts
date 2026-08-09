/**
 * Shared test fixtures — the vitest equivalent of the Python suite's conftest.
 *
 * `Settings` is memoized and reads `.env` relative to the current working
 * directory, so every test runs from a fresh temp directory with the cache
 * cleared. Without that, a developer's real `.env` would leak live credentials
 * into tests that deliberately unset them.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearSettingsCache } from '../src/config.js';

/** Environment variables the suite manages, cleared between tests. */
const MANAGED_ENV_KEYS = [
  'SONARQUBE_URL',
  'SONARQUBE_TOKEN',
  'SONARQUBE_USERNAME',
  'SONARQUBE_PASSWORD',
  'SONARQUBE_ORGANIZATION',
  'SONARQUBE_TIMEOUT_SECONDS',
  'SONARQUBE_MAX_RETRIES',
  'SONARQUBE_RETRY_BACKOFF_SECONDS',
  'SONARQUBE_PAGE_SIZE',
  'SONARQUBE_VERIFY_SSL',
  'MCP_REPO_ROOT',
  'MCP_MAX_READ_FILE_BYTES',
  'MCP_MAX_WRITE_FILE_BYTES',
  'MCP_LOG_LEVEL',
] as const;

const createdDirs: string[] = [];
let originalCwd: string | null = null;

/** Create a throwaway directory, cleaned up by {@link resetEnvironment}. */
export function makeTempDir(): string {
  // realpath: macOS reports /var, which is a symlink to /private/var, and the
  // sandbox containment check compares fully resolved paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sonarqube-mcp-test-')));
  createdDirs.push(dir);
  return dir;
}

/**
 * Build a small fake repository:
 *
 * ```
 * src/app.ts     "export function add(...)"
 * src/util.ts    "const SECRET = ..."
 * README.md
 * ```
 */
export function makeRepoRoot(): string {
  const root = makeTempDir();
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'export function add(a, b) {\n  return a + b;\n}\n');
  writeFileSync(join(root, 'src', 'util.ts'), "const SECRET = 'do not print secrets';\n");
  writeFileSync(join(root, 'README.md'), '# fake project\n');
  return root;
}

/**
 * Point the server at `repoRoot` with valid credentials and a zero retry
 * backoff, so retry tests don't spend real seconds sleeping.
 */
export function configureEnv(repoRoot: string): void {
  clearManagedEnv();
  process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
  process.env['SONARQUBE_TOKEN'] = 'test-token';
  process.env['MCP_REPO_ROOT'] = repoRoot;
  process.env['SONARQUBE_RETRY_BACKOFF_SECONDS'] = '0';

  originalCwd ??= process.cwd();
  process.chdir(repoRoot);
  clearSettingsCache();
}

/** Remove every managed variable from the environment. */
export function clearManagedEnv(): void {
  for (const key of MANAGED_ENV_KEYS) delete process.env[key];
  clearSettingsCache();
}

/** Restore the cwd, clear the env, and delete temp directories. */
export function resetEnvironment(): void {
  if (originalCwd !== null) {
    process.chdir(originalCwd);
    originalCwd = null;
  }
  clearManagedEnv();
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a `fetch` stub returning a JSON response. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Build a `fetch` stub returning a plain-text response. */
export function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}
