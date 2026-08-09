import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SonarQubeClient, type FetchLike } from '../src/client.js';
import { clearSettingsCache, getSettings } from '../src/config.js';
import {
  SonarQubeAPIError,
  SonarQubeAuthenticationError,
  SonarQubeConnectionError,
  SonarQubeNotFoundError,
  SonarQubeRateLimitError,
} from '../src/errors.js';
import { configureEnv, jsonResponse, makeRepoRoot, resetEnvironment, textResponse } from './helpers.js';

const projectsPayload = {
  paging: { pageIndex: 1, pageSize: 100, total: 1 },
  components: [
    {
      key: 'proj1',
      name: 'Project One',
      qualifier: 'TRK',
      visibility: 'private',
      lastAnalysisDate: '2026-08-01T12:00:00+0000',
    },
  ],
};

/** Build a client backed by a stub fetch, recording every URL it requests. */
function makeClient(handler: (url: URL) => Response | Promise<Response>): {
  client: SonarQubeClient;
  urls: URL[];
} {
  const urls: URL[] = [];
  const fetchImpl: FetchLike = async (url) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return handler(parsed);
  };
  return { client: new SonarQubeClient(getSettings(), fetchImpl), urls };
}

beforeEach(() => {
  configureEnv(makeRepoRoot());
});

afterEach(() => {
  resetEnvironment();
});

describe('projects', () => {
  it('parses the response', async () => {
    const { client, urls } = makeClient((url) => {
      // Must be the non-admin components endpoint: api/projects/search
      // requires "Administer System" and 403s for ordinary users.
      expect(url.pathname).toBe('/api/components/search');
      expect(url.searchParams.get('qualifiers')).toBe('TRK');
      return jsonResponse(projectsPayload);
    });

    const projects = await client.getAllProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.key).toBe('proj1');
    expect(projects[0]?.name).toBe('Project One');
    expect(urls).toHaveLength(1);
  });

  it('paginates', async () => {
    const pages: Record<string, unknown> = {
      '1': { paging: { pageIndex: 1, pageSize: 1, total: 2 }, components: [{ key: 'a', name: 'A' }] },
      '2': { paging: { pageIndex: 2, pageSize: 1, total: 2 }, components: [{ key: 'b', name: 'B' }] },
    };
    const { client } = makeClient((url) =>
      jsonResponse(pages[url.searchParams.get('p') ?? '1']),
    );

    const projects = await client.getAllProjects();
    expect(projects.map((p) => p.key)).toEqual(['a', 'b']);
  });

  it('sends the organization param when configured', async () => {
    process.env['SONARQUBE_ORGANIZATION'] = 'my-org';
    clearSettingsCache();

    const { client } = makeClient((url) => {
      expect(url.searchParams.get('organization')).toBe('my-org');
      return jsonResponse(projectsPayload);
    });
    await client.searchProjects();
  });
});

describe('issues', () => {
  it('filters and parses', async () => {
    const { client } = makeClient((url) => {
      expect(url.searchParams.get('componentKeys')).toBe('proj1');
      expect(url.searchParams.get('severities')).toBe('BLOCKER,CRITICAL');
      return jsonResponse({
        total: 1,
        paging: { pageIndex: 1, pageSize: 100, total: 1 },
        issues: [
          {
            key: 'ISSUE1',
            rule: 'typescript:S1481',
            severity: 'BLOCKER',
            component: 'proj1:src/app.ts',
            project: 'proj1',
            line: 2,
            message: 'Unused variable',
            type: 'CODE_SMELL',
            status: 'OPEN',
          },
        ],
      });
    });

    const issues = await client.getAllIssues('proj1', { severities: ['BLOCKER', 'CRITICAL'] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.key).toBe('ISSUE1');
    expect(issues[0]?.severity).toBe('BLOCKER');
  });

  it('caps results at maxResults', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        total: 10,
        paging: { pageIndex: 1, pageSize: 5, total: 10 },
        issues: Array.from({ length: 5 }, (_unused, i) => ({
          key: `ISSUE${i}`,
          rule: 'r',
          severity: 'MAJOR',
          component: 'c',
          project: 'p',
          message: 'm',
          type: 'BUG',
          status: 'OPEN',
        })),
      }),
    );

    expect(await client.getAllIssues('proj1', { maxResults: 3 })).toHaveLength(3);
  });

  it('throws when an issue key has no match', async () => {
    const { client } = makeClient(() =>
      jsonResponse({ total: 0, paging: { pageIndex: 1, pageSize: 1, total: 0 }, issues: [] }),
    );
    await expect(client.getIssue('does-not-exist')).rejects.toThrow(SonarQubeNotFoundError);
  });
});

describe('quality gate and measures', () => {
  it('parses quality gate conditions', async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        projectStatus: {
          status: 'ERROR',
          conditions: [
            {
              status: 'ERROR',
              metricKey: 'coverage',
              comparator: 'LT',
              errorThreshold: '80',
              actualValue: '42',
            },
          ],
        },
      }),
    );

    const gate = await client.getQualityGateStatus('proj1');
    expect(gate.status).toBe('ERROR');
    expect(gate.conditions[0]?.metricKey).toBe('coverage');
  });

  it('throws on an unexpected quality gate shape', async () => {
    const { client } = makeClient(() => jsonResponse({ unexpected: true }));
    await expect(client.getQualityGateStatus('proj1')).rejects.toThrow(SonarQubeAPIError);
  });

  it('parses measures', async () => {
    const { client } = makeClient((url) => {
      expect(url.searchParams.get('metricKeys')).toBe('bugs,coverage');
      return jsonResponse({
        component: { key: 'proj1', name: 'P1', measures: [{ metric: 'bugs', value: '3' }] },
      });
    });

    const metrics = await client.getMeasures('proj1', ['bugs', 'coverage']);
    expect(metrics.key).toBe('proj1');
    expect(metrics.measures[0]?.metric).toBe('bugs');
  });
});

describe('error mapping and retries', () => {
  it('raises an auth error on 401 without retrying', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return textResponse('unauthorized', 401);
    });

    await expect(client.searchProjects()).rejects.toThrow(SonarQubeAuthenticationError);
    expect(calls).toBe(1);
  });

  it('raises not-found on 404', async () => {
    const { client } = makeClient(() => textResponse('not found', 404));
    await expect(client.searchProjects()).rejects.toThrow(SonarQubeNotFoundError);
  });

  it('retries a 429 up to the retry budget', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return textResponse('slow down', 429);
    });

    await expect(client.searchProjects()).rejects.toThrow(SonarQubeRateLimitError);
    // maxRetries defaults to 3 -> 4 total attempts
    expect(calls).toBe(4);
  });

  it('retries a 5xx then raises an API error carrying the status', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return textResponse('unavailable', 503);
    });

    await expect(client.searchProjects()).rejects.toMatchObject({
      name: 'SonarQubeAPIError',
      statusCode: 503,
    });
    expect(calls).toBe(4);
  });

  it('succeeds when a 5xx recovers within the retry budget', async () => {
    let calls = 0;
    const { client } = makeClient(() => {
      calls += 1;
      return calls < 3 ? textResponse('unavailable', 503) : jsonResponse(projectsPayload);
    });

    const result = await client.searchProjects();
    expect(result.components[0]?.key).toBe('proj1');
    expect(calls).toBe(3);
  });

  it('maps a transport failure to a connection error', async () => {
    const client = new SonarQubeClient(getSettings(), () => {
      throw new TypeError('fetch failed');
    });
    await expect(client.searchProjects()).rejects.toThrow(SonarQubeConnectionError);
  });

  it('raises an API error for non-JSON success bodies', async () => {
    const { client } = makeClient(() => new Response('<html>nope</html>', { status: 200 }));
    await expect(client.searchProjects()).rejects.toThrow(SonarQubeAPIError);
  });

  it('sends basic auth built from the token', async () => {
    let authHeader: string | null = null;
    const client = new SonarQubeClient(getSettings(), async (url, init) => {
      authHeader = new Headers(init.headers).get('Authorization');
      return jsonResponse(projectsPayload);
    });

    await client.searchProjects();
    expect(authHeader).toBe(`Basic ${Buffer.from('test-token:', 'utf-8').toString('base64')}`);
  });
});
