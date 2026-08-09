#!/usr/bin/env node
/**
 * Entry point and application wiring for the sonarqube-mcp MCP server.
 *
 * This module owns the single `McpServer` instance, opens one pooled
 * {@link SonarQubeClient} for the life of the process, and registers the tools,
 * resources, and prompts before connecting over stdio.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SonarQubeClient } from './client.js';
import { getSettings, type Settings } from './config.js';
import { ConfigurationError } from './errors.js';
import { configureLogging, getLogger } from './logging.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { registerTools } from './tools.js';

const logger = getLogger('sonarqube-mcp.server');

const SERVER_INSTRUCTIONS =
  'Tools for querying SonarQube/SonarCloud (projects, issues, quality gates, metrics) ' +
  'and for safely reading and writing files in the connected repository. write_file ' +
  'always requires an explicit confirmed=true from the caller after the user has ' +
  'approved a shown diff — never call it with confirmed=true on the first attempt.';

/**
 * Build a fully wired MCP server plus the client it owns.
 *
 * Exported so tests can drive the server in-process over an in-memory
 * transport, without spawning a subprocess.
 */
export function createServer(
  settings: Settings,
  client: SonarQubeClient = new SonarQubeClient(settings),
): { server: McpServer; client: SonarQubeClient } {
  const server = new McpServer(
    { name: 'sonarqube-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  const getClient = (): SonarQubeClient => client;
  registerTools(server, getClient);
  registerResources(server, getClient);
  registerPrompts(server);

  return { server, client };
}

/** Console-script entry point (`sonarqube-mcp`). Runs over stdio. */
export async function main(): Promise<void> {
  let settings: Settings;
  try {
    settings = getSettings();
  } catch (error) {
    // Fail fast and loud on stderr — Claude Code shows this if the server
    // can't start, which is far more useful than a stack trace.
    const message = error instanceof ConfigurationError ? error.message : String(error);
    process.stderr.write(`sonarqube-mcp failed to start: ${message}\n`);
    process.exit(1);
  }

  configureLogging(settings.logLevel);

  if (!settings.verifySsl) {
    // Node's fetch offers no per-request TLS override, so this is process-wide.
    // Acceptable here: the process talks to exactly one host, the configured
    // SonarQube server.
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    logger.warning(
      'SONARQUBE_VERIFY_SSL=false — TLS certificate verification is DISABLED for this process.',
    );
  }

  const { server, client } = createServer(settings);
  logger.info(`SonarQube MCP server starting up (target=${settings.sonarqubeUrl})`);
  logger.info(`Repository tools sandboxed to: ${settings.repoRoot}`);

  const shutdown = async (): Promise<void> => {
    logger.info('SonarQube MCP server shutting down');
    await client.close();
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await server.connect(new StdioServerTransport());
}

/**
 * True when this module is the process entry point.
 *
 * Compared as file URLs rather than raw strings so Windows drive letters and
 * backslashes normalize correctly.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// Run only when executed directly, not when imported by tests.
if (isMainModule()) {
  main().catch((error: unknown) => {
    process.stderr.write(`sonarqube-mcp crashed: ${String(error)}\n`);
    process.exit(1);
  });
}
