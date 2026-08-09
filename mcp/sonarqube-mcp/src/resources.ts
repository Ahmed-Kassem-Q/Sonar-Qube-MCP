/**
 * Read-only MCP resources exposing SonarQube data as addressable URIs.
 *
 * Resources are for passive context — "what does this project's data look like
 * right now" — as opposed to tools, which represent actions. All four resources
 * here return `application/json` text.
 *
 * Unlike the Python implementation, which opened a short-lived HTTP client per
 * resource read (a workaround for the Python SDK not injecting Context into
 * static resources), these share the same pooled client as the tools.
 */

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { SonarQubeClient } from './client.js';
import { SonarQubeNotFoundError } from './errors.js';
import { DEFAULT_METRIC_KEYS } from './models.js';

const MIME_TYPE = 'application/json';

function toJson(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

/** Register every resource on `server`. */
export function registerResources(server: McpServer, getClient: () => SonarQubeClient): void {
  server.registerResource(
    'sonarqube-projects',
    'sonar://projects',
    {
      title: 'SonarQube projects',
      description: 'All SonarQube projects visible to the configured credentials.',
      mimeType: MIME_TYPE,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MIME_TYPE,
          text: toJson(await getClient().getAllProjects()),
        },
      ],
    }),
  );

  server.registerResource(
    'sonarqube-project',
    new ResourceTemplate('sonar://projects/{project_key}', { list: undefined }),
    {
      title: 'SonarQube project details',
      description: 'Details for a single SonarQube project.',
      mimeType: MIME_TYPE,
    },
    async (uri, { project_key }) => {
      const key = String(project_key);
      const matches = await getClient().getAllProjects({ query: key });
      const project = matches.find((candidate) => candidate.key === key);
      if (project === undefined) {
        throw new SonarQubeNotFoundError(`No project found with key '${key}'.`);
      }
      return {
        contents: [{ uri: uri.href, mimeType: MIME_TYPE, text: toJson(project) }],
      };
    },
  );

  server.registerResource(
    'sonarqube-project-issues',
    new ResourceTemplate('sonar://projects/{project_key}/issues', { list: undefined }),
    {
      title: 'SonarQube project issues',
      description: 'All open issues for a single SonarQube project.',
      mimeType: MIME_TYPE,
    },
    async (uri, { project_key }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MIME_TYPE,
          text: toJson(await getClient().getAllIssues(String(project_key))),
        },
      ],
    }),
  );

  server.registerResource(
    'sonarqube-project-metrics',
    new ResourceTemplate('sonar://projects/{project_key}/metrics', { list: undefined }),
    {
      title: 'SonarQube project metrics',
      description: 'Headline code quality metrics for a single SonarQube project.',
      mimeType: MIME_TYPE,
    },
    async (uri, { project_key }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: MIME_TYPE,
          text: toJson(await getClient().getMeasures(String(project_key), DEFAULT_METRIC_KEYS)),
        },
      ],
    }),
  );
}
