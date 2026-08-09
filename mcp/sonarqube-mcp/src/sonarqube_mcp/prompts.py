"""MCP prompts: reusable workflow templates for Claude Code.

Prompts here are pure text templates — they do **not** call the SonarQube
API themselves. Each one instructs Claude to drive the workflow using the
tools defined in :mod:`sonarqube_mcp.tools`, which keeps the prompt cheap to
render, keeps data-fetching auditable (every SonarQube call shows up as a
distinct tool call in the transcript), and matches how MCP prompts are
meant to be used: as guidance for the calling LLM, not as a place to hide
side effects.
"""

from __future__ import annotations

from textwrap import dedent

from sonarqube_mcp.server import mcp


@mcp.prompt(
    name="sonar_review",
    description=(
        "Structured SonarQube review for a project: retrieve issues, categorize them, "
        "find root causes, propose fixes, and produce a prioritized action list."
    ),
)
def sonar_review(project_key: str) -> str:
    """Guide a full SonarQube issue review for a project."""
    return dedent(
        f"""
        You are performing a SonarQube code-quality review for project `{project_key}`.
        Use the sonarqube-mcp and repository tools to work through this workflow in
        order. Do not skip steps, and do not modify any files during this review.

        1. Retrieve issues
           - Call `get_project_issues(project_key="{project_key}")` for the full open
             issue list.
           - Call `get_quality_gate(project_key="{project_key}")` for the current gate
             status and failing conditions.
           - Call `get_project_metrics(project_key="{project_key}")` for headline
             reliability/security/maintainability/coverage numbers.

        2. Categorize
           - Group issues by `type` (BUG, VULNERABILITY, CODE_SMELL, SECURITY_HOTSPOT)
             and by `severity` (BLOCKER, CRITICAL, MAJOR, MINOR, INFO).
           - Note any recurring `rule` values — a rule that fires dozens of times
             usually points at one systemic root cause rather than many unrelated bugs.

        3. Root cause analysis
           - For each distinct issue category or recurring rule, use `read_file` and
             `search_code` to inspect the affected source and explain *why* the issue
             occurs (e.g. a missing null check pattern, an unvalidated input, a copied
             helper function), not just a restatement of the rule description.

        4. Recommended fixes
           - Propose a concrete, minimal code-level fix for each issue category.
             Show the change as a unified diff against the current file content.
             Do NOT call `write_file` during this review — this step is proposal-only.

        5. Priority
           - Rank the categories by severity, blast radius (how many files/call sites
             are affected), and estimated effort, producing a prioritized action list.
             Security issues (VULNERABILITY, SECURITY_HOTSPOT) and BLOCKER/CRITICAL
             severities should be ranked first regardless of effort.

        Present your findings as a structured report with these sections: Summary,
        Quality Gate, Issues by Category, Root Causes, Proposed Fixes (diffs), and
        Prioritized Action Plan. If the user wants any fix actually applied, tell them
        to use the `fix_issue` prompt or the `fix-sonarqube-issues` skill for that
        specific issue key.
        """
    ).strip()


@mcp.prompt(
    name="pr_review",
    description=(
        "Review the changed code in this branch/PR for security, maintainability, "
        "architecture, performance, and coding-standards issues, and summarize."
    ),
)
def pr_review(base_ref: str = "main", head_ref: str = "HEAD") -> str:
    """Guide a pull-request-style review of the currently changed code."""
    return dedent(
        f"""
        You are reviewing the code changes between `{base_ref}` and `{head_ref}` in
        this repository, as a senior engineer would before approving a pull request.

        1. Review changed code
           - Determine which files changed between `{base_ref}` and `{head_ref}`
             (e.g. via `git diff --name-only {base_ref}...{head_ref}` through your
             shell/bash tool, since this MCP server does not shell out to git itself).
           - Use `read_file` to read each changed file's current content in full —
             do not review from the diff hunks alone; surrounding context matters.
           - If a SonarQube project key is known for this repository, call
             `get_project_issues` (optionally scoped by severity/type) and
             `get_quality_gate` to cross-reference any SonarQube findings that touch
             the changed files.

        2. Security
           - Look for injection risks, missing input validation, secrets or
             credentials committed in code, unsafe deserialization, missing
             authorization checks, and any SonarQube VULNERABILITY/SECURITY_HOTSPOT
             issues that intersect the diff.

        3. Maintainability
           - Look for duplicated logic, unclear naming, missing or misleading
             docstrings/comments, overly long functions, and any SonarQube
             CODE_SMELL issues that intersect the diff.

        4. Architecture
           - Check that the change respects existing module boundaries and layering,
             doesn't introduce circular dependencies, and follows the patterns already
             established elsewhere in the codebase (use `search_code` to confirm
             conventions before flagging a deviation).

        5. Performance
           - Look for obvious algorithmic issues (N+1 queries, unnecessary
             synchronous I/O in hot paths, unbounded loops/recursion, missing
             pagination on new endpoints).

        6. Coding standards
           - Check adherence to this repository's formatting/lint configuration and
             any team conventions visible in surrounding code (e.g. via
             `search_code` for similar existing patterns).

        7. Summary
           - Produce PR feedback with sections: Overview, Blocking Issues (must fix
             before merge), Suggestions (nice to have), and Approval Recommendation
             (approve / approve with comments / request changes). Cite specific
             file:line locations for every finding.

        Do not modify any files during this review — this prompt is read-only. If the
        user wants a fix applied, use the `fix_issue` prompt or the
        `fix-sonarqube-issues` / `pre-pr-review` skills instead.
        """
    ).strip()


@mcp.prompt(
    name="fix_issue",
    description=(
        "Retrieve a specific SonarQube issue, locate and read the affected file, "
        "propose a fix, and WAIT for explicit user confirmation before applying it."
    ),
)
def fix_issue(issue_key: str) -> str:
    """Guide a single-issue fix workflow with a mandatory confirmation gate."""
    return dedent(
        f"""
        You are fixing SonarQube issue `{issue_key}`. Follow this workflow exactly and
        in order — the confirmation step is mandatory and not optional.

        1. Retrieve the issue
           - Call `get_issue_details(issue_key="{issue_key}")` to get the rule,
             severity, type, message, component (file path), and line number.

        2. Find the affected file
           - The issue's `component` field is `<project_key>:<path>` — the part after
             the colon is the file path relative to the repository root. Use
             `search_files` if the exact path needs confirming.

        3. Read the code
           - Call `read_file` on the affected file and inspect the surrounding
             context around the reported line, not just the single line.

        4. Analyze
           - Explain what the rule is checking for and why this specific code
             triggers it — the actual root cause, in this codebase's context.

        5. Propose a fix
           - Write the smallest correct change that resolves the issue without
             changing unrelated behavior. Show it as a unified diff (before/after)
             against the file's current content. Do NOT call `write_file` yet.

        6. WAIT FOR USER CONFIRMATION
           - Stop here and explicitly ask the user to approve the diff shown in
             step 5. Do not proceed past this point without an explicit "yes" /
             "approved" / equivalent response from the user in this conversation.

        7. Apply the fix (only after confirmation)
           - Once — and only once — the user has confirmed, call `write_file` with
             `confirmed=True` and the complete updated file content. `write_file`
             will refuse the write if `confirmed` is not `True`, by design.
           - After writing, consider recommending the user (or your build/test
             tools, if available in this session) re-run the project's build and
             test suite to confirm nothing else broke.

        Never skip step 6. If the user has not yet responded to the proposed diff,
        end your turn after step 5/6 rather than guessing at their intent.
        """
    ).strip()
