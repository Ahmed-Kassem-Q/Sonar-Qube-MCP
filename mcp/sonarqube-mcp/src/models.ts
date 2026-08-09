/**
 * Zod schemas mirroring the subset of the SonarQube/SonarCloud Web API this
 * server consumes.
 *
 * The API returns camelCase JSON, and these schemas keep those names so parsing
 * is a direct mapping with no aliasing layer. Unknown fields are stripped
 * rather than rejected, so a SonarQube upgrade that adds fields cannot break
 * the server.
 *
 * These schemas double as the MCP tools' structured output schemas, so keeping
 * them precise and well-described directly improves what Claude sees about each
 * tool's result shape.
 */

import { z } from 'zod';

/** SonarQube issue severity levels, from least to most severe. */
export const SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

/** SonarQube issue categories. */
export const ISSUE_TYPES = ['CODE_SMELL', 'BUG', 'VULNERABILITY', 'SECURITY_HOTSPOT'] as const;
export const issueTypeSchema = z.enum(ISSUE_TYPES);
export type IssueType = z.infer<typeof issueTypeSchema>;

/** SonarQube issue workflow states. */
export const ISSUE_STATUSES = [
  'OPEN',
  'CONFIRMED',
  'REOPENED',
  'RESOLVED',
  'CLOSED',
  'TO_REVIEW',
  'IN_REVIEW',
  'REVIEWED',
] as const;
export const issueStatusSchema = z.enum(ISSUE_STATUSES);
export type IssueStatus = z.infer<typeof issueStatusSchema>;

/** Overall SonarQube quality gate status. */
export const QUALITY_GATE_STATUSES = ['OK', 'ERROR', 'WARN', 'NONE'] as const;
export const qualityGateStatusSchema = z.enum(QUALITY_GATE_STATUSES);
export type QualityGateStatus = z.infer<typeof qualityGateStatusSchema>;

/** Pagination metadata returned by SonarQube list endpoints. */
export const pagingSchema = z.object({
  pageIndex: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type Paging = z.infer<typeof pagingSchema>;

/** A single SonarQube project. */
export const projectSchema = z.object({
  key: z.string(),
  name: z.string(),
  qualifier: z.string().nullish(),
  visibility: z.string().nullish(),
  lastAnalysisDate: z.string().nullish(),
});
export type Project = z.infer<typeof projectSchema>;

/** Response envelope for `GET /api/components/search?qualifiers=TRK`. */
export const projectsPageSchema = z.object({
  paging: pagingSchema,
  components: z.array(projectSchema).default([]),
});
export type ProjectsPage = z.infer<typeof projectsPageSchema>;

/** Location of an issue within its source file. */
export const textRangeSchema = z.object({
  startLine: z.number().int().nullish(),
  endLine: z.number().int().nullish(),
  startOffset: z.number().int().nullish(),
  endOffset: z.number().int().nullish(),
});
export type TextRange = z.infer<typeof textRangeSchema>;

/** A single SonarQube issue (bug, vulnerability, code smell, or hotspot). */
export const issueSchema = z.object({
  key: z.string(),
  rule: z.string(),
  severity: severitySchema,
  component: z.string(),
  project: z.string(),
  line: z.number().int().nullish(),
  textRange: textRangeSchema.nullish(),
  message: z.string(),
  type: issueTypeSchema,
  status: issueStatusSchema,
  resolution: z.string().nullish(),
  author: z.string().nullish(),
  tags: z.array(z.string()).default([]),
  creationDate: z.string().nullish(),
  updateDate: z.string().nullish(),
  effort: z.string().nullish(),
  debt: z.string().nullish(),
});
export type Issue = z.infer<typeof issueSchema>;

/** Response envelope for `GET /api/issues/search`. */
export const issuesPageSchema = z.object({
  total: z.number().int(),
  paging: pagingSchema,
  issues: z.array(issueSchema).default([]),
});
export type IssuesPage = z.infer<typeof issuesPageSchema>;

/** A single condition (metric threshold) within a quality gate. */
export const qualityGateConditionSchema = z.object({
  status: qualityGateStatusSchema,
  metricKey: z.string(),
  comparator: z.string(),
  errorThreshold: z.string().nullish(),
  actualValue: z.string().nullish(),
});
export type QualityGateCondition = z.infer<typeof qualityGateConditionSchema>;

/** Parsed `projectStatus` object from `api/qualitygates/project_status`. */
export const qualityGateResultSchema = z.object({
  status: qualityGateStatusSchema,
  conditions: z.array(qualityGateConditionSchema).default([]),
  ignoredConditions: z.boolean().nullish(),
});
export type QualityGateResult = z.infer<typeof qualityGateResultSchema>;

/** A single metric measurement for a project. */
export const measureSchema = z.object({
  metric: z.string(),
  value: z.string().nullish(),
  bestValue: z.boolean().nullish(),
});
export type Measure = z.infer<typeof measureSchema>;

/** Parsed `component` object from `api/measures/component`. */
export const projectMetricsSchema = z.object({
  key: z.string(),
  name: z.string().nullish(),
  measures: z.array(measureSchema).default([]),
});
export type ProjectMetrics = z.infer<typeof projectMetricsSchema>;

/**
 * Default metrics fetched by `get_project_metrics` when the caller does not
 * specify `metric_keys`. Covers the headline reliability / security /
 * maintainability / coverage / size indicators.
 */
export const DEFAULT_METRIC_KEYS: readonly string[] = [
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots',
  'coverage',
  'duplicated_lines_density',
  'ncloc',
  'reliability_rating',
  'security_rating',
  'sqale_rating',
  'alert_status',
];

/** Result of a successful `write_file` call. */
export const writeResultSchema = z.object({
  path: z.string(),
  bytesWritten: z.number().int(),
  created: z.boolean(),
});
export type WriteResult = z.infer<typeof writeResultSchema>;

/** A single line matching a `search_code` query. */
export const codeSearchMatchSchema = z.object({
  path: z.string(),
  lineNumber: z.number().int(),
  lineText: z.string(),
});
export type CodeSearchMatch = z.infer<typeof codeSearchMatchSchema>;
