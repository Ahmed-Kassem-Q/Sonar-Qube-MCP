/**
 * MCP tools exposed by sonarqube-mcp.
 *
 * Two families of tools live here:
 *
 * 1. **SonarQube tools** (`get_projects`, `get_project_issues`,
 *    `get_critical_issues`, `get_quality_gate`, `get_issue_details`,
 *    `get_project_metrics`, `get_duplicated_files`, `get_file_duplications`)
 *    — thin, validating wrappers around
 *    {@link SonarQubeClient}.
 * 2. **Repository access tools** (`read_file`, `write_file`, `list_files`,
 *    `search_code`, `search_files`) — thin wrappers around `repoAccess.ts`,
 *    sandboxed to `MCP_REPO_ROOT`.
 *
 * Per the project's safety rules, `write_file` never writes on its first call:
 * it requires an explicit `confirmed=true`, which callers (Claude, guided by
 * the `fix_issue` prompt and the `fix-sonarqube-issues` skill) only pass after
 * the user has seen the proposed diff and approved it.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { SonarQubeClient } from './client.js';
import { RepositoryAccessError } from './errors.js';
import {
  codeSearchMatchSchema,
  componentMeasuresSchema,
  DEFAULT_DUPLICATION_METRIC_KEYS,
  DEFAULT_METRIC_KEYS,
  fileDuplicationsSchema,
  issueSchema,
  issueStatusSchema,
  issueTypeSchema,
  projectMetricsSchema,
  projectSchema,
  qualityGateResultSchema,
  severitySchema,
  writeResultSchema,
} from './models.js';
import {
  listRepoFiles,
  readFileContent,
  searchRepoCode,
  searchRepoFiles,
  writeFileContent,
} from './repoAccess.js';

/**
 * Build a tool result carrying both a JSON text rendering (what Claude reads)
 * and the structured payload validated against the tool's `outputSchema`.
 */
function result(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** Parse a case-insensitive enum value, with a helpful message on failure. */
function parseEnum<T extends string>(
  schema: z.ZodType<T>,
  raw: string | undefined,
  fieldName: string,
  valid: readonly string[],
): T | undefined {
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw.trim().toUpperCase());
  if (!parsed.success) {
    throw new Error(`Invalid ${fieldName} '${raw}'. Valid values: ${valid.join(', ')}`);
  }
  return parsed.data;
}

/** Register every tool on `server`. */
export function registerTools(server: McpServer, getClient: () => SonarQubeClient): void {
  // -------------------------------------------------------------------------
  // SonarQube tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_projects',
    {
      title: 'List SonarQube projects',
      description:
        'List SonarQube projects visible to the configured credentials. ' +
        'Optionally filter by a case-insensitive substring of the project name or key.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Optional case-insensitive substring to filter projects by name or key ' +
              "(matches the SonarQube UI's project search box).",
          ),
      },
      outputSchema: { projects: z.array(projectSchema) },
    },
    async ({ query }) => result({ projects: await getClient().getAllProjects({ query }) }),
  );

  server.registerTool(
    'get_project_issues',
    {
      title: 'Get project issues',
      description: 'Retrieve issues for a SonarQube project, with optional filters.',
      inputSchema: {
        project_key: z.string().describe('The SonarQube project key (e.g. my-org_my-repo).'),
        severity: z
          .string()
          .optional()
          .describe('Optional single severity filter — INFO, MINOR, MAJOR, CRITICAL, or BLOCKER.'),
        issue_type: z
          .string()
          .optional()
          .describe(
            'Optional single type filter — CODE_SMELL, BUG, VULNERABILITY, or SECURITY_HOTSPOT.',
          ),
        status: z
          .string()
          .optional()
          .describe(
            'Optional single status filter — OPEN, CONFIRMED, REOPENED, RESOLVED, ' +
              'CLOSED, TO_REVIEW, IN_REVIEW, or REVIEWED.',
          ),
        max_results: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe('Upper bound on the number of issues returned. Defaults to 200.'),
      },
      outputSchema: { issues: z.array(issueSchema) },
    },
    async ({ project_key, severity, issue_type, status, max_results }) => {
      const parsedSeverity = parseEnum(severitySchema, severity, 'severity', severitySchema.options);
      const parsedType = parseEnum(issueTypeSchema, issue_type, 'issue_type', issueTypeSchema.options);
      const parsedStatus = parseEnum(issueStatusSchema, status, 'status', issueStatusSchema.options);

      const issues = await getClient().getAllIssues(project_key, {
        severities: parsedSeverity ? [parsedSeverity] : undefined,
        types: parsedType ? [parsedType] : undefined,
        statuses: parsedStatus ? [parsedStatus] : undefined,
        maxResults: max_results,
      });
      return result({ issues });
    },
  );

  server.registerTool(
    'get_critical_issues',
    {
      title: 'Get critical issues',
      description:
        'Retrieve only BLOCKER and CRITICAL severity issues for a project. Use this to ' +
        'triage the highest-priority findings first, ahead of a release or before ' +
        'starting a broader cleanup pass.',
      inputSchema: {
        project_key: z.string().describe('The SonarQube project key.'),
        max_results: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe('Upper bound on the number of issues returned.'),
      },
      outputSchema: { issues: z.array(issueSchema) },
    },
    async ({ project_key, max_results }) => {
      const issues = await getClient().getAllIssues(project_key, {
        severities: ['BLOCKER', 'CRITICAL'],
        maxResults: max_results,
      });
      return result({ issues });
    },
  );

  server.registerTool(
    'get_quality_gate',
    {
      title: 'Get quality gate status',
      description: 'Get the current Quality Gate status and its per-metric conditions.',
      inputSchema: { project_key: z.string().describe('The SonarQube project key.') },
      outputSchema: qualityGateResultSchema.shape,
    },
    async ({ project_key }) => result(await getClient().getQualityGateStatus(project_key)),
  );

  server.registerTool(
    'get_issue_details',
    {
      title: 'Get issue details',
      description: 'Get full details for a single SonarQube issue by its key.',
      inputSchema: {
        issue_key: z.string().describe('The SonarQube issue key (e.g. AYg1abcXYZ123).'),
      },
      outputSchema: issueSchema.shape,
    },
    async ({ issue_key }) => result(await getClient().getIssue(issue_key)),
  );

  server.registerTool(
    'get_project_metrics',
    {
      title: 'Get project metrics',
      description:
        'Get code quality metrics for a project (bugs, vulnerabilities, coverage, etc.).',
      inputSchema: {
        project_key: z.string().describe('The SonarQube project key.'),
        metric_keys: z
          .array(z.string())
          .optional()
          .describe(
            'Optional explicit list of SonarQube metric keys to fetch. Defaults to a ' +
              'sensible set covering reliability, security, maintainability, coverage, ' +
              'duplication, size, and the overall quality-gate status.',
          ),
      },
      outputSchema: projectMetricsSchema.shape,
    },
    async ({ project_key, metric_keys }) =>
      result(await getClient().getMeasures(project_key, metric_keys ?? DEFAULT_METRIC_KEYS)),
  );

  server.registerTool(
    'get_duplicated_files',
    {
      title: 'Rank files by duplicated lines',
      description:
        'List the files in a project ranked by duplicated lines, highest first. Use this ' +
        'to find where duplication actually lives before planning a refactor, instead of ' +
        'guessing from code that merely looks similar. Follow up with get_file_duplications ' +
        'on the top entries to confirm the exact duplicated blocks.',
      inputSchema: {
        project_key: z.string().describe('The SonarQube project key.'),
        metric_keys: z
          .array(z.string())
          .optional()
          .describe(
            'Optional explicit list of metric keys to report per file. Defaults to the ' +
              'duplication set (duplicated_lines, duplicated_blocks, ' +
              'duplicated_lines_density) plus ncloc.',
          ),
        sort_metric: z
          .string()
          .default('duplicated_lines')
          .describe(
            'Metric to rank by, descending. Must also appear in metric_keys. Defaults to ' +
              'duplicated_lines — the metric a duplication-reduction pass is measured in.',
          ),
        only_with_measures: z
          .boolean()
          .default(true)
          .describe(
            'Whether to omit files that have no value for sort_metric. Defaults to true, ' +
              'so clean files do not pad the result.',
          ),
        max_results: z
          .number()
          .int()
          .positive()
          .default(100)
          .describe('Upper bound on the number of files returned. Defaults to 100.'),
      },
      outputSchema: { components: z.array(componentMeasuresSchema) },
    },
    async ({ project_key, metric_keys, sort_metric, only_with_measures, max_results }) => {
      const metricKeys = metric_keys ?? DEFAULT_DUPLICATION_METRIC_KEYS;
      if (!metricKeys.includes(sort_metric)) {
        throw new Error(
          `sort_metric '${sort_metric}' must also appear in metric_keys ` +
            `(got: ${metricKeys.join(', ')}). SonarQube can only rank by a metric it was asked to return.`,
        );
      }

      const components = await getClient().getComponentTree(project_key, {
        metricKeys,
        sortMetric: sort_metric,
        withMeasuresOnly: only_with_measures,
        maxResults: max_results,
      });
      return result({ components });
    },
  );

  server.registerTool(
    'get_file_duplications',
    {
      title: 'Get duplicated blocks for a file',
      description:
        'Show the exact duplicated line ranges SonarQube found for a single file, and the ' +
        'other files each range matches. This is the ground truth for a duplication ' +
        'refactor: use it to confirm a match is genuine copy-paste logic before changing ' +
        'anything, and to rule out false targets such as static seed data, generated code, ' +
        'or config literals, which are structurally repetitive but should not be abstracted.',
      inputSchema: {
        component_key: z
          .string()
          .describe(
            'The fully-qualified SonarQube component key of the file — the project key, a ' +
              'colon, then the repo-relative path (e.g. my-org_my-repo:src/Services/Report.cs). ' +
              'This is the `component` field on an issue, or the `key` field returned by ' +
              'get_duplicated_files.',
          ),
      },
      outputSchema: fileDuplicationsSchema.shape,
    },
    async ({ component_key }) => result(await getClient().getDuplications(component_key)),
  );

  // -------------------------------------------------------------------------
  // Repository access tools
  // -------------------------------------------------------------------------

  server.registerTool(
    'read_file',
    {
      title: 'Read a repository file',
      description:
        'Read and return the UTF-8 text contents of a file in the connected repository.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'Path relative to the repository root (MCP_REPO_ROOT). Absolute paths and ' +
              '".." segments that escape the repository root are rejected.',
          ),
      },
      outputSchema: { content: z.string() },
    },
    async ({ path }) => result({ content: readFileContent(path) }),
  );

  server.registerTool(
    'write_file',
    {
      title: 'Write a repository file',
      description:
        'Write text content to a file in the connected repository. SAFETY RULE: this ' +
        'tool refuses to write unless confirmed=true is passed explicitly. The correct ' +
        'workflow is: show the issue, explain the root cause, show the proposed diff to ' +
        'the user, and only call this tool with confirmed=true after the user has ' +
        'explicitly approved it.',
      inputSchema: {
        path: z
          .string()
          .describe(
            'Path relative to the repository root. Parent directories are created ' +
              'automatically. Absolute paths and ".." segments that escape the ' +
              'repository root are rejected.',
          ),
        content: z
          .string()
          .describe(
            'The full new file content to write (this replaces the entire file — ' +
              'always read the current content first and edit it, rather than guessing ' +
              'at partial content).',
          ),
        confirmed: z
          .boolean()
          .default(false)
          .describe(
            'Must be explicitly set to true. Defaults to false so an accidental or ' +
              'premature call never modifies source code.',
          ),
      },
      outputSchema: writeResultSchema.shape,
    },
    async ({ path, content, confirmed }) => {
      if (!confirmed) {
        throw new RepositoryAccessError(
          'Refusing to write without confirmation. Show the issue, its root cause, and ' +
            'the proposed diff to the user, obtain explicit confirmation, then call ' +
            'write_file again with confirmed=true.',
        );
      }
      return result(writeFileContent(path, content));
    },
  );

  server.registerTool(
    'list_files',
    {
      title: 'List repository files',
      description: 'List files in the connected repository, relative to the repository root.',
      inputSchema: {
        directory: z
          .string()
          .default('.')
          .describe(
            'Directory to list, relative to the repository root. Defaults to the root itself.',
          ),
        pattern: z
          .string()
          .default('*')
          .describe('Filename glob filter (e.g. *.ts). Defaults to * (all files).'),
        recursive: z
          .boolean()
          .default(true)
          .describe('Whether to descend into subdirectories. Defaults to true.'),
        max_results: z
          .number()
          .int()
          .positive()
          .default(2000)
          .describe('Upper bound on the number of paths returned.'),
      },
      outputSchema: { files: z.array(z.string()) },
    },
    async ({ directory, pattern, recursive, max_results }) =>
      result({ files: listRepoFiles(directory, { pattern, recursive, maxResults: max_results }) }),
  );

  server.registerTool(
    'search_code',
    {
      title: 'Search repository code',
      description:
        'Search file contents in the connected repository for a keyword (grep-style).',
      inputSchema: {
        keyword: z.string().describe('Text to search for within each line of each matching file.'),
        file_pattern: z
          .string()
          .default('*')
          .describe(
            'Filename glob restricting which files are searched (e.g. *.ts). ' +
              'Defaults to * (all text files).',
          ),
        case_sensitive: z
          .boolean()
          .default(false)
          .describe('Whether the search is case-sensitive. Defaults to false.'),
        max_results: z
          .number()
          .int()
          .positive()
          .default(200)
          .describe('Upper bound on the number of matching lines returned.'),
      },
      outputSchema: { matches: z.array(codeSearchMatchSchema) },
    },
    async ({ keyword, file_pattern, case_sensitive, max_results }) =>
      result({
        matches: searchRepoCode(keyword, {
          filePattern: file_pattern,
          caseSensitive: case_sensitive,
          maxResults: max_results,
        }),
      }),
  );

  server.registerTool(
    'search_files',
    {
      title: 'Find files by path glob',
      description:
        'Find files whose path matches a glob pattern (e.g. **/test_*.ts). Unlike ' +
        'list_files (which filters by filename within a directory), search_files matches ' +
        'the glob against the full relative path, so it also supports patterns like src/**/*.ts.',
      inputSchema: {
        pattern: z.string().describe('A glob pattern, relative to the repository root.'),
        recursive: z
          .boolean()
          .default(true)
          .describe(
            'Whether the pattern may also match at any depth below the root. Defaults to true.',
          ),
        max_results: z
          .number()
          .int()
          .positive()
          .default(2000)
          .describe('Upper bound on the number of paths returned.'),
      },
      outputSchema: { files: z.array(z.string()) },
    },
    async ({ pattern, recursive, max_results }) =>
      result({ files: searchRepoFiles(pattern, { recursive, maxResults: max_results }) }),
  );
}
