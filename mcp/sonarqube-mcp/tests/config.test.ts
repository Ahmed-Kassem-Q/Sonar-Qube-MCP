import { afterEach, describe, expect, it } from 'vitest';

import { buildSettings, clearSettingsCache, getSettings } from '../src/config.js';
import { ConfigurationError } from '../src/errors.js';
import { clearManagedEnv, configureEnv, makeRepoRoot, resetEnvironment } from './helpers.js';

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
