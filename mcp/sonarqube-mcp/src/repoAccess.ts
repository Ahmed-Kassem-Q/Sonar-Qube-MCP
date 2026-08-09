/**
 * Sandboxed filesystem helpers backing the repository-access MCP tools.
 *
 * Every function here resolves paths against `settings.repoRoot` and refuses to
 * touch anything outside it, so a malformed or malicious `path` argument (e.g.
 * `../../etc/passwd` or an absolute path) can never escape the connected
 * repository. This module holds pure filesystem logic; the tool wrappers in
 * `tools.ts` are thin adapters over it, kept separate so the safety-critical
 * path logic has a single, easily reviewed and testable home.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getSettings, type Settings } from './config.js';
import { RepositoryAccessError } from './errors.js';
import { matchesFilename, matchesPath } from './glob.js';
import type { CodeSearchMatch, WriteResult } from './models.js';

/**
 * Directories that are never walked — build artifacts, VCS internals, and
 * dependency caches that are typically huge, binary-heavy, and irrelevant to
 * source-level review.
 */
export const IGNORED_DIR_NAMES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.venv',
  'venv',
  'node_modules',
  'dist',
  'build',
  '.idea',
  '.vscode',
  'bin',
  'obj',
]);

/** Files above this size are skipped by searchRepoCode (binary/generated heuristic). */
const MAX_SEARCH_FILE_BYTES = 5_000_000;

/** Convert an OS-native path to the POSIX form used in all tool output. */
function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * Fully resolve a path, following symlinks as far as the path exists.
 *
 * `realpathSync` throws on a path that does not exist yet (the `write_file`
 * create case), so resolve the deepest existing ancestor and re-append the
 * remainder. Resolving symlinks matters for security: without it, a symlink
 * inside the repo pointing outside it would defeat the containment check.
 */
function resolveExistingPrefix(target: string): string {
  let current = resolve(target);
  const trailing: string[] = [];

  for (;;) {
    if (existsSync(current)) {
      return join(realpathSync(current), ...trailing.reverse());
    }
    const parent = dirname(current);
    if (parent === current) return resolve(target); // reached the filesystem root
    trailing.push(current.slice(parent.length + 1));
    current = parent;
  }
}

/** True when `child` is `root` itself or lies beneath it. */
function isContained(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve `relativePath` against the configured repo root.
 *
 * @throws {RepositoryAccessError} if the resolved path would fall outside the
 *   repository root (path traversal, symlink escape, or an absolute path
 *   pointing elsewhere).
 */
export function resolveRepoPath(relativePath: string, settings: Settings = getSettings()): string {
  const expanded = relativePath.startsWith('~')
    ? relativePath.replace(/^~/, homedir())
    : relativePath;

  // An absolute argument is resolved as-is and then containment-checked, so an
  // absolute path *inside* the repo is allowed while one outside is rejected.
  const candidate = isAbsolute(expanded)
    ? resolveExistingPrefix(expanded)
    : resolveExistingPrefix(join(settings.repoRoot, expanded));

  const root = existsSync(settings.repoRoot)
    ? realpathSync(settings.repoRoot)
    : resolve(settings.repoRoot);

  if (!isContained(root, candidate)) {
    throw new RepositoryAccessError(
      `Path '${relativePath}' resolves outside the connected repository root (${root}) and is not allowed.`,
    );
  }
  return candidate;
}

/** Repo-root-relative POSIX path, for tool output. */
function relativeToRoot(absolutePath: string, settings: Settings): string {
  const root = existsSync(settings.repoRoot)
    ? realpathSync(settings.repoRoot)
    : resolve(settings.repoRoot);
  return toPosix(relative(root, absolutePath));
}

/**
 * Read a text file within the repository root.
 *
 * @throws {RepositoryAccessError} on path traversal, a missing file, a
 *   directory path, non-UTF-8 content, or a file larger than
 *   `MCP_MAX_READ_FILE_BYTES`.
 */
export function readFileContent(relativePath: string): string {
  const settings = getSettings();
  const path = resolveRepoPath(relativePath, settings);

  if (!existsSync(path)) {
    throw new RepositoryAccessError(`File not found: ${relativePath}`);
  }
  const stats = statSync(path);
  if (stats.isDirectory()) {
    throw new RepositoryAccessError(`'${relativePath}' is a directory, not a file.`);
  }
  if (stats.size > settings.maxReadFileBytes) {
    throw new RepositoryAccessError(
      `'${relativePath}' is ${stats.size} bytes, exceeding the ` +
        `${settings.maxReadFileBytes}-byte read limit (MCP_MAX_READ_FILE_BYTES).`,
    );
  }

  const buffer = readFileSync(path);
  const text = buffer.toString('utf-8');
  // Node substitutes U+FFFD for invalid UTF-8 rather than throwing, so detect
  // binary content by round-tripping and comparing.
  if (text.includes('�') && !Buffer.from(text, 'utf-8').equals(buffer)) {
    throw new RepositoryAccessError(
      `'${relativePath}' does not appear to be a UTF-8 text file.`,
    );
  }
  return text;
}

/**
 * Write `content` to a file within the repository root, creating parents.
 *
 * Callers (the `write_file` MCP tool) enforce the "ask the user first" safety
 * gate — this function performs the write unconditionally once called.
 *
 * @throws {RepositoryAccessError} on path traversal, a target that is an
 *   existing directory, or content larger than `MCP_MAX_WRITE_FILE_BYTES`.
 */
export function writeFileContent(relativePath: string, content: string): WriteResult {
  const settings = getSettings();
  const path = resolveRepoPath(relativePath, settings);

  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > settings.maxWriteFileBytes) {
    throw new RepositoryAccessError(
      `Refusing to write ${byteLength} bytes to '${relativePath}': exceeds the ` +
        `${settings.maxWriteFileBytes}-byte write limit (MCP_MAX_WRITE_FILE_BYTES).`,
    );
  }
  const exists = existsSync(path);
  if (exists && statSync(path).isDirectory()) {
    throw new RepositoryAccessError(`'${relativePath}' is a directory, not a file.`);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf-8');

  return {
    path: relativeToRoot(path, settings),
    bytesWritten: byteLength,
    created: !exists,
  };
}

/** Walk files beneath `startDir`, skipping {@link IGNORED_DIR_NAMES}. */
function* walkFiles(startDir: string, recursive = true): Generator<string> {
  let entries;
  try {
    entries = readdirSync(startDir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — skip rather than fail the whole walk
  }

  for (const entry of entries) {
    const full = join(startDir, entry.name);
    if (entry.isDirectory()) {
      if (!recursive || IGNORED_DIR_NAMES.has(entry.name)) continue;
      yield* walkFiles(full, recursive);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * List files under `directory` (relative to the repo root).
 *
 * `pattern` is a filename glob (e.g. `*.ts`). Common VCS/build/dependency
 * directories (see {@link IGNORED_DIR_NAMES}) are always skipped.
 */
export function listRepoFiles(
  directory = '.',
  options: { pattern?: string; recursive?: boolean; maxResults?: number } = {},
): string[] {
  const { pattern = '*', recursive = true, maxResults = 2000 } = options;
  const settings = getSettings();
  const start = resolveRepoPath(directory, settings);

  if (!existsSync(start)) {
    throw new RepositoryAccessError(`Directory not found: ${directory}`);
  }
  if (!statSync(start).isDirectory()) {
    throw new RepositoryAccessError(`'${directory}' is not a directory.`);
  }

  const results: string[] = [];
  for (const file of walkFiles(start, recursive)) {
    if (!matchesFilename(file.slice(file.lastIndexOf(sep) + 1), pattern)) continue;
    results.push(relativeToRoot(file, settings));
    if (results.length >= maxResults) break;
  }
  return results.sort();
}

/** Find files whose *path* matches a glob pattern (e.g. `src/**\/*.ts`). */
export function searchRepoFiles(
  pattern: string,
  options: { recursive?: boolean; maxResults?: number } = {},
): string[] {
  const { recursive = true, maxResults = 2000 } = options;
  const settings = getSettings();

  const results: string[] = [];
  for (const file of walkFiles(resolveRepoPath('.', settings), true)) {
    const rel = relativeToRoot(file, settings);
    if (!matchesPath(rel, pattern, recursive)) continue;
    results.push(rel);
    if (results.length >= maxResults) break;
  }
  return results.sort();
}

/** Grep-style search for `keyword` across text files under the repo root. */
export function searchRepoCode(
  keyword: string,
  options: { filePattern?: string; caseSensitive?: boolean; maxResults?: number } = {},
): CodeSearchMatch[] {
  const { filePattern = '*', caseSensitive = false, maxResults = 200 } = options;
  if (!keyword) {
    throw new RepositoryAccessError("search_code requires a non-empty 'keyword'.");
  }

  const settings = getSettings();
  const needle = caseSensitive ? keyword : keyword.toLowerCase();
  const matches: CodeSearchMatch[] = [];

  for (const file of walkFiles(resolveRepoPath('.', settings), true)) {
    if (!matchesFilename(file.slice(file.lastIndexOf(sep) + 1), filePattern)) continue;

    let text: string;
    try {
      if (statSync(file).size > MAX_SEARCH_FILE_BYTES) continue;
      text = readFileSync(file, 'utf-8');
    } catch {
      continue; // binary or unreadable file — skip rather than fail the search
    }

    const relPath = relativeToRoot(file, settings);
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const haystack = caseSensitive ? line : line.toLowerCase();
      if (!haystack.includes(needle)) continue;
      matches.push({ path: relPath, lineNumber: index + 1, lineText: line.trim() });
      if (matches.length >= maxResults) return matches;
    }
  }
  return matches;
}
