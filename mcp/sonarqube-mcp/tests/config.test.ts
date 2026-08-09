import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyDotEnvFiles,
  buildSettings,
  clearSettingsCache,
  dotEnvSearchPaths,
  getSettings,
  globalEnvPath,
} from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';
import {
  clearManagedEnv,
  configureEnv,
  makeRepoRoot,
  makeTempDir,
  resetEnvironment,
} from './helpers.js';

afterEach(() => {
  resetEnvironment();
});

describe('settings validation', () => {
  it('requires credentials', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    expect(() => buildSettings(process.env)).toThrow(ConfigurationError);
  });

  it('uses the token as the basic-auth username', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    process.env['SONARQUBE_TOKEN'] = 'abc123';
    expect(buildSettings(process.env).auth).toEqual({ username: 'abc123', password: '' });
  });

  it('falls back to basic auth when no token is set', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    process.env['SONARQUBE_USERNAME'] = 'alice';
    process.env['SONARQUBE_PASSWORD'] = 'hunter2';
    expect(buildSettings(process.env).auth).toEqual({ username: 'alice', password: 'hunter2' });
  });

  it('strips a trailing slash from the URL', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io/';
    process.env['SONARQUBE_TOKEN'] = 'abc123';
    expect(buildSettings(process.env).sonarqubeUrl).toBe('https://sonarcloud.io');
  });

  it('rejects an invalid log level', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    process.env['SONARQUBE_TOKEN'] = 'abc123';
    process.env['MCP_LOG_LEVEL'] = 'NOT_A_LEVEL';
    expect(() => buildSettings(process.env)).toThrow(ConfigurationError);
  });

  it('rejects an out-of-range page size', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    process.env['SONARQUBE_TOKEN'] = 'abc123';
    process.env['SONARQUBE_PAGE_SIZE'] = '9999';
    expect(() => buildSettings(process.env)).toThrow(ConfigurationError);
  });

  it('treats an empty organization as unset rather than invalid', () => {
    clearManagedEnv();
    process.env['SONARQUBE_URL'] = 'https://sonarcloud.io';
    process.env['SONARQUBE_TOKEN'] = 'abc123';
    process.env['SONARQUBE_ORGANIZATION'] = '';
    expect(buildSettings(process.env).sonarqubeOrganization).toBeUndefined();
  });

  it('reads values from a .env file', () => {
    const root = makeRepoRoot();
    configureEnv(root);
    delete process.env['MCP_SKIP_DOTENV'];
    delete process.env['SONARQUBE_URL'];
    delete process.env['SONARQUBE_TOKEN'];
    writeFileSync(
      join(root, '.env'),
      '# a comment\nSONARQUBE_URL=https://from-dotenv.example\nSONARQUBE_TOKEN="quoted-token"\n\n',
    );
    clearSettingsCache();

    const settings = getSettings();
    expect(settings.sonarqubeUrl).toBe('https://from-dotenv.example');
    expect(settings.auth).toEqual({ username: 'quoted-token', password: '' });
  });

  it('lets a real environment variable win over .env', () => {
    const root = makeRepoRoot();
    configureEnv(root);
    delete process.env['MCP_SKIP_DOTENV'];
    writeFileSync(join(root, '.env'), 'SONARQUBE_URL=https://from-dotenv.example\n');
    process.env['SONARQUBE_URL'] = 'https://from-env.example';
    clearSettingsCache();

    expect(getSettings().sonarqubeUrl).toBe('https://from-env.example');
  });

  it('layers .env files instead of stopping at the first one found', () => {
    // Regression: an unrelated project .env (most projects have one) used to
    // shadow the global config entirely, so a plugin install failed to start
    // despite valid global credentials sitting in ~/.config.
    const dir = makeTempDir();
    const projectEnv = join(dir, 'project.env');
    const globalEnv = join(dir, 'global.env');
    writeFileSync(projectEnv, 'DATABASE_URL=postgres://localhost/app\n');
    writeFileSync(globalEnv, 'SONARQUBE_URL=https://global.example\nSONARQUBE_TOKEN=global\n');

    const env = {};
    applyDotEnvFiles([projectEnv, globalEnv], env);

    expect(env).toEqual({
      DATABASE_URL: 'postgres://localhost/app',
      SONARQUBE_URL: 'https://global.example',
      SONARQUBE_TOKEN: 'global',
    });
  });

  it('lets the earlier .env win per key when both define one', () => {
    const dir = makeTempDir();
    const projectEnv = join(dir, 'project.env');
    const globalEnv = join(dir, 'global.env');
    writeFileSync(projectEnv, 'SONARQUBE_URL=https://project.example\n');
    writeFileSync(globalEnv, 'SONARQUBE_URL=https://global.example\nSONARQUBE_TOKEN=global\n');

    const env = {};
    applyDotEnvFiles([projectEnv, globalEnv], env);

    // The nearer file wins on the key it sets; the global still fills the gap.
    expect(env).toEqual({
      SONARQUBE_URL: 'https://project.example',
      SONARQUBE_TOKEN: 'global',
    });
  });

  it('never overwrites a variable already present in the environment', () => {
    const dir = makeTempDir();
    const envFile = join(dir, 'a.env');
    writeFileSync(envFile, 'SONARQUBE_URL=https://from-file.example\n');

    const env = { SONARQUBE_URL: 'https://from-shell.example' };
    applyDotEnvFiles([envFile], env);

    expect(env['SONARQUBE_URL']).toBe('https://from-shell.example');
  });

  it('includes the global config directory in the search path', () => {
    expect(dotEnvSearchPaths().at(-1)).toBe(globalEnvPath());
    expect(globalEnvPath()).toMatch(/sonarqube-mcp[/\\]\.env$/);
  });

  it('memoizes getSettings', () => {
    configureEnv(makeRepoRoot());
    expect(getSettings()).toBe(getSettings());
  });

  it('re-reads the environment after the cache is cleared', () => {
    configureEnv(makeRepoRoot());
    const first = getSettings();
    process.env['SONARQUBE_URL'] = 'https://example.invalid';
    clearSettingsCache();
    expect(getSettings()).not.toBe(first);
    expect(getSettings().sonarqubeUrl).toBe('https://example.invalid');
  });
});
