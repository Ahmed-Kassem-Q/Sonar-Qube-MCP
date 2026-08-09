# Workflow: fix-sonarqube-issues

## 1. Retrieve SonarQube issues

Pick the right tool for the scope the user asked for:

- A specific issue key → `get_issue_details(issue_key="...")`.
- "Fix the critical/blocker issues in `<project>`" → `get_critical_issues(project_key="...")`.
- "Fix all bugs/vulnerabilities in `<project>`" → `get_project_issues(project_key="...", issue_type="BUG")` (or `"VULNERABILITY"`).
- Everything for a project → `get_project_issues(project_key="...")`, then triage by
  severity yourself (BLOCKER/CRITICAL first).

Also call `get_quality_gate(project_key="...")` up front if the user's goal is "make
the quality gate pass" — it tells you exactly which metrics are failing, which may
narrow the issue list you actually need to act on.

## 2. Find affected files

Every issue's `component` field looks like `<project_key>:<path/relative/to/repo>`.
Strip the `<project_key>:` prefix to get the repository-relative path. If you're not
sure the path lines up with this checkout (e.g. monorepo with a different SonarQube
project root), confirm with `search_files` or `list_files` before reading.

## 3. Read the source

Always use `read_file` and read enough surrounding context (the whole function or
class, not just the reported line) — SonarQube's `line`/`textRange` fields point at
where the rule fired, which is often a symptom, not the root cause.

## 4. Analyze root cause

For each issue (or each group of issues sharing a `rule`), write one or two sentences
explaining *why* this code triggers the rule in this specific context. Group issues by
`rule` when there are many — a single systemic fix (e.g. adding a shared validation
helper) is often better than N near-identical point fixes.

## 5. Propose a fix

- Prefer the smallest correct change. Don't refactor unrelated code in the same pass.
- Show a unified diff (before/after) for every file you intend to change, even if
  several issues in the same file are being fixed together.
- Do **not** call `write_file` yet.

## 6. WAIT — confirmation gate

Stop and explicitly ask: *"Apply this fix?"* / *"Shall I write these N files?"* Do not
proceed on an assumption. If the user is not present (unattended run), stop here and
leave the proposed diffs as your output rather than guessing consent.

## 7. Apply

Once confirmed, call `write_file(path=..., content=..., confirmed=True)` for each
file — pass the complete new file content, not a patch fragment. If several files
need to change for one issue (rare), apply them together before moving to build/test.

## 8. Build

Look for this repository's build command (check for `package.json` scripts, a
`Makefile`, `pyproject.toml` build/test config, a CI workflow file under
`.github/workflows/`, etc. — use `list_files`/`search_files`/`read_file` to find it,
then run it with your shell/bash tool). Report build success/failure verbatim.

## 9. Test

Run the project's test suite the same way. If tests fail *because of your change*,
treat this as a new issue: show the failure, propose a corrected diff, and go back to
step 6 (confirmation) before reapplying.

## 10. Report

Produce a short Markdown report (see `examples.md` for the shape) covering: issues
targeted, issues fixed vs. skipped (with reasons), diffs applied, build result, test
result, and any follow-up recommended for issues that were out of scope for this pass.
