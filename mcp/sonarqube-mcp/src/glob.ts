/**
 * Minimal glob matching, standing in for Python's `fnmatch` / `Path.rglob`.
 *
 * Written by hand rather than pulled from npm: the repository tools need only
 * `*`, `**`, `?`, and `[...]`, and a hand-rolled matcher keeps the install
 * footprint at two runtime dependencies. The semantics are deliberately the
 * ones the Python implementation had, so ported tests keep their meaning.
 */

/** Characters that must be escaped to appear literally in a RegExp. */
const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

/**
 * Translate a glob pattern into an anchored regular expression.
 *
 * - `**` matches across path separators (`src/**\/*.ts`)
 * - `*` matches within a single path segment
 * - `?` matches exactly one character other than a separator
 * - `[abc]` / `[!abc]` match a character class
 *
 * @param pattern - The glob pattern.
 * @param options - `matchSeparators: true` lets a single `*` cross `/`, which
 *   is what filename-only matching (`fnmatch`) wants, since a bare filename
 *   contains no separators anyway.
 */
export function globToRegExp(pattern: string, options: { matchSeparators?: boolean } = {}): RegExp {
  const single = options.matchSeparators ? '[^]' : '[^/]';
  let out = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // `**` — consume the pair plus an immediately following separator so
        // that `a/**/b` also matches `a/b`.
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          out += '(?:[^]*\\/)?';
        } else {
          out += '[^]*';
        }
      } else {
        out += `${single}*`;
      }
      continue;
    }

    if (char === '?') {
      out += single;
      continue;
    }

    if (char === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) {
        out += '\\[';
        continue;
      }
      let body = pattern.slice(i + 1, end);
      body = body.startsWith('!') ? `^${body.slice(1)}` : body;
      out += `[${body}]`;
      i = end;
      continue;
    }

    if (char === '/') {
      out += '\\/';
      continue;
    }

    out += char.replace(REGEX_SPECIALS, '\\$&');
  }

  return new RegExp(`^${out}$`);
}

/**
 * Match a bare filename against a glob, the way Python's `fnmatch.fnmatch` did.
 *
 * Matching is case-insensitive on Windows and case-sensitive elsewhere, which
 * mirrors how each platform's filesystem behaves.
 */
export function matchesFilename(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  const flags = process.platform === 'win32' ? 'i' : '';
  const source = globToRegExp(pattern, { matchSeparators: true }).source;
  return new RegExp(source, flags).test(name);
}

/**
 * Match a repo-relative path (POSIX separators) against a glob pattern.
 *
 * When `recursive` is set, the pattern may also match at any depth — so
 * `*.ts` finds nested files, matching what `Path.rglob` did in the Python
 * implementation.
 */
export function matchesPath(relativePath: string, pattern: string, recursive = true): boolean {
  const flags = process.platform === 'win32' ? 'i' : '';
  const direct = new RegExp(globToRegExp(pattern).source, flags);
  if (direct.test(relativePath)) return true;
  if (!recursive || pattern.startsWith('**')) return false;
  const nested = new RegExp(globToRegExp(`**/${pattern}`).source, flags);
  return nested.test(relativePath);
}
