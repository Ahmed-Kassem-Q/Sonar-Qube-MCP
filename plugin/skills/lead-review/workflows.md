# Workflow: lead-review

## 1. Establish scope

Confirm (or infer from context) which project/repository and, if this is a monorepo,
which subtree, is in scope. If a SonarQube project key is known, note it — you'll use
it in step 3.

## 2. Map the codebase

- `list_files(recursive=True)` (or scoped to a subdirectory for large monorepos) to
  understand the overall shape: languages present, top-level module boundaries,
  test-to-source ratio, presence of docs/ADRs.
- `search_files` for common architecture signals: `**/Dockerfile`,
  `**/docker-compose*.yml`, `**/*.proto`, `**/openapi*.yaml`, CI config
  (`.github/workflows/**`, `.gitlab-ci.yml`), IaC (`**/*.tf`).
- Read key entry points (`main`, `app`, top-level `server`/`index` files) to
  understand runtime composition.

## 3. Pull SonarQube signal

- `get_quality_gate(project_key="...")` for the current pass/fail state and which
  metrics are failing.
- `get_project_metrics(project_key="...")` for the headline numbers (bugs,
  vulnerabilities, code smells, coverage, duplication, ratings).
- `get_project_issues(project_key="...")` filtered or grouped by type/severity —
  use this to find *clusters* (a rule firing 40 times across one module is an
  architecture/pattern signal, not 40 independent bugs).

## 4. Architecture

Assess: module boundaries and whether they're actually respected (check for
suspicious cross-module imports via `search_code`), coupling/cohesion, whether the
tech stack matches the problem (over-engineered vs. under-engineered), and whether
the CI/build setup matches how the code is actually structured.

## 5. Security

Cross-reference SonarQube `VULNERABILITY`/`SECURITY_HOTSPOT` issues with a manual
skim for: secrets in source (`search_code` for suspicious patterns like `api_key`,
`password =`, `BEGIN PRIVATE KEY`), authn/authz boundaries, dependency
manifests (note outdated/unpinned dependencies if visible), and input validation at
trust boundaries (API handlers, file parsers).

## 6. Performance

Look for structural performance risks: N+1 query patterns, synchronous I/O in
request-handling hot paths, unbounded collections/caches, missing pagination on
list-returning endpoints, and anything the SonarQube metrics flag as a reliability
or performance-adjacent rule.

## 7. Maintainability

Coverage percentage and trend (from `get_project_metrics`), duplication percentage,
`CODE_SMELL` volume and distribution, presence/quality of tests relative to
complexity, and whether documentation (README, ADRs, inline docs) matches reality.

## 8. Technical debt

Synthesize the above into a debt inventory: what's actively risky vs. merely
unpleasant, and a rough sense of what would need to happen (and roughly how much
effort) to pay down the top 3-5 items.

## 9. Generate the report

Follow the template in `examples.md`. Cite specific files/modules/metrics for every
claim — a lead review with no receipts doesn't get acted on.
