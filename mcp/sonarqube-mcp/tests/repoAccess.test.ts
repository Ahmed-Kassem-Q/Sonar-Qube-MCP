import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RepositoryAccessError } from '../src/errors.js';
import {
  listRepoFiles,
  readFileContent,
  searchRepoCode,
  searchRepoFiles,
  writeFileContent,
} from '../src/repoAccess.js';
import { configureEnv, makeRepoRoot, resetEnvironment } from './helpers.js';

let repoRoot: string;

beforeEach(() => {
  repoRoot = makeRepoRoot();
  configureEnv(repoRoot);
});

afterEach(() => {
  resetEnvironment();
});

describe('readFileContent', () => {
  it('returns file content', () => {
    expect(readFileContent('src/app.ts')).toBe('export function add(a, b) {\n  return a + b;\n}\n');
  });

  it('throws for a missing file', () => {
    expect(() => readFileContent('src/does_not_exist.ts')).toThrow(RepositoryAccessError);
  });

  it('rejects path traversal', () => {
    expect(() => readFileContent('../../etc/passwd')).toThrow(RepositoryAccessError);
  });

  it('rejects an absolute path outside the root', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    expect(() => readFileContent(outside)).toThrow(RepositoryAccessError);
  });

  it('rejects a directory', () => {
    expect(() => readFileContent('src')).toThrow(RepositoryAccessError);
  });
});

describe('writeFileContent', () => {
  it('creates parent directories', () => {
    const result = writeFileContent('new/nested/file.txt', 'hello\n');
    expect(result.created).toBe(true);
    expect(result.bytesWritten).toBe(6);
    expect(readFileContent('new/nested/file.txt')).toBe('hello\n');
  });

  it('rejects path traversal', () => {
    expect(() => writeFileContent('../escape.txt', 'pwned')).toThrow(RepositoryAccessError);
  });

  it('reports created=false when overwriting', () => {
    const result = writeFileContent('src/app.ts', '// patched\n');
    expect(result.created).toBe(false);
  });

  it('returns a repo-relative posix path', () => {
    expect(writeFileContent('src/deep/x.ts', 'x\n').path).toBe('src/deep/x.ts');
  });
});

describe('listRepoFiles', () => {
  it('filters by filename pattern', () => {
    expect(new Set(listRepoFiles('.', { pattern: '*.ts' }))).toEqual(
      new Set(['src/app.ts', 'src/util.ts']),
    );
  });

  it('throws for a missing directory', () => {
    expect(() => listRepoFiles('does/not/exist')).toThrow(RepositoryAccessError);
  });

  it('skips ignored directories', () => {
    writeFileSync(join(repoRoot, 'src', 'app.js'), 'x\n');
    const files = listRepoFiles('.', { pattern: '*' });
    expect(files).toContain('README.md');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });

  it('honours recursive=false', () => {
    expect(listRepoFiles('.', { pattern: '*', recursive: false })).toEqual(['README.md']);
  });
});

describe('searchRepoFiles', () => {
  it('matches a path glob', () => {
    expect(new Set(searchRepoFiles('src/*.ts'))).toEqual(new Set(['src/app.ts', 'src/util.ts']));
  });

  it('matches nested files from a bare pattern', () => {
    expect(new Set(searchRepoFiles('*.ts'))).toEqual(new Set(['src/app.ts', 'src/util.ts']));
  });

  it('supports ** patterns', () => {
    expect(new Set(searchRepoFiles('**/*.ts'))).toEqual(new Set(['src/app.ts', 'src/util.ts']));
  });
});

describe('searchRepoCode', () => {
  it('finds a match', () => {
    const matches = searchRepoCode('SECRET');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.path).toBe('src/util.ts');
    expect(matches[0]?.lineNumber).toBe(1);
  });

  it('is case-insensitive by default', () => {
    expect(searchRepoCode('secret')).toHaveLength(1);
  });

  it('honours case_sensitive', () => {
    // The fixture contains "SECRET" (upper) and "secrets" (lower, inside a
    // different word) but never the exact-case token "Secret".
    expect(searchRepoCode('Secret', { caseSensitive: true })).toEqual([]);
  });

  it('throws on an empty keyword', () => {
    expect(() => searchRepoCode('')).toThrow(RepositoryAccessError);
  });

  it('respects maxResults', () => {
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(repoRoot, `gen_${i}.ts`), 'MATCHME\n');
    }
    expect(searchRepoCode('MATCHME', { maxResults: 3 })).toHaveLength(3);
  });

  it('restricts the search by file pattern', () => {
    writeFileSync(join(repoRoot, 'notes.md'), 'SECRET\n');
    expect(searchRepoCode('SECRET', { filePattern: '*.md' })).toHaveLength(1);
    expect(searchRepoCode('SECRET', { filePattern: '*.md' })[0]?.path).toBe('notes.md');
  });
});
