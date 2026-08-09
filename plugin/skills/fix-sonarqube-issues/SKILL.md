---
name: fix-sonarqube-issues
description: Fix SonarQube/SonarCloud issues in this repository using the sonarqube-mcp server. Retrieves issues, locates and reads affected files, proposes a fix, WAITS for explicit user confirmation, then applies the fix, runs the build and tests, and generates a report. Trigger on "/fix-sonarqube-issues", "fix sonarqube issues", "resolve sonar findings", "clean up sonar issues", or a request to fix a specific SonarQube issue key.
---

# Fix SonarQube Issues

Use this skill to work through SonarQube/SonarCloud findings in this repository and
apply fixes safely, one confirmed change at a time. It depends on the `sonarqube-mcp`
MCP server being connected (check with `/mcp` — it should be named `sonarqube`).

Read `workflows.md` for the full step-by-step procedure, `examples.md` for sample
conversations, and `best-practices.md` before fixing security-sensitive or
high-blast-radius issues.

## When to use this

- The user asks you to fix one or more SonarQube issues, by key or by
  severity/type/project.
- The user asks you to "clean up" or "resolve" SonarQube/Sonar findings for a project.
- The user invokes `/fix-sonarqube-issues` directly.

## Non-negotiable safety rule

**Never call `write_file` with `confirmed=True` without an explicit approval from the
user in this conversation for that specific change.** The `write_file` tool itself
enforces this (it raises an error if `confirmed` is not `True`), but do not try to
work around it — the gate exists so a human always reviews a diff before source code
changes. If the user says "just fix everything, don't ask me each time" for a batch of
issues, still show every diff up front (batched) and get one explicit go-ahead before
applying any of them — never silently skip the confirmation step.

## Quick procedure (see workflows.md for detail)

1. Retrieve the target issue(s) via `get_project_issues` / `get_critical_issues` /
   `get_issue_details`.
2. For each issue: find the affected file (`component` field, or `search_files`),
   read it with `read_file`.
3. Analyze the root cause — don't just restate the rule.
4. Propose a minimal fix as a unified diff. Do not write anything yet.
5. **Wait for user confirmation** — stop and ask.
6. On confirmation, call `write_file` with `confirmed=True`.
7. Run this repository's build and test commands (see `workflows.md` for how to find
   them) and report the results.
8. Generate a short Markdown report summarizing what was fixed, what wasn't, and why.

You can also delegate the retrieve → propose-fix portion of this to the `fix_issue`
MCP prompt exposed by `sonarqube-mcp` (`Use the fix_issue prompt for issue key ...`),
which encodes the same confirmation gate.
