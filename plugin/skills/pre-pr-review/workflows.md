# Workflow: pre-pr-review

## 1. Identify the changed files

This MCP server doesn't shell out to git itself, so use your own shell/bash tool for
this step: something like `git status --porcelain` and
`git diff --name-only <base-branch>...` (ask the user for the base branch if it isn't
obvious — default to `main` if the repository clearly uses that convention).

## 2. Read every changed file in full

Use `read_file` on each changed file's *current* content — review the whole file for
context, not just the diff hunks; a change can be locally correct but wrong in
context (e.g. now inconsistent with a sibling function).

## 3. Cross-reference SonarQube

If a SonarQube project key is known for this repository:

- `get_project_issues(project_key="...")` and intersect the results' `component`
  paths against your changed-files list — flag any pre-existing or newly-introduced
  issues that touch the diff.
- `get_quality_gate(project_key="...")` to check whether this change would plausibly
  push a borderline metric over its threshold (e.g. coverage dropping because new
  code has no tests).

Note: SonarQube's server-side analysis reflects the last *pushed/analyzed* commit,
not your uncommitted working tree — treat its issue list as "known issues in this
area," not a live scan of the exact diff. Say so in the report if relevant.

## 4. Security review

For each changed file, check for: injection risk (SQL/command/template),
unvalidated input at new trust boundaries, secrets or credentials, missing
authorization checks on new/changed endpoints, unsafe deserialization, and any
SonarQube VULNERABILITY/SECURITY_HOTSPOT issues intersecting the diff (step 3).

## 5. Performance review

Look for obvious issues introduced by the diff: N+1 queries, new synchronous I/O in
a hot path, unbounded loops/recursion over user-controlled input, missing pagination
on a new list endpoint.

## 6. Coding standards review

Check the diff against conventions visible elsewhere in the repo — use `search_code`
to find how similar things are done nearby before flagging a deviation as wrong
rather than just different. Check for consistent naming, error handling, and logging
patterns; check that any repo-level lint/format config (if present) would pass.

## 7. Generate PR feedback

Follow the template in `examples.md`: Changed Files, Security, SonarQube Compliance,
Performance, Coding Standards, then a clear Recommendation. Cite file:line for every
finding. Split findings into **Blocking** (must fix before merge) vs. **Suggestions**
(nice to have) explicitly.
