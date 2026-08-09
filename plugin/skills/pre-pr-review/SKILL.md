---
name: pre-pr-review
description: Review the changed files in the current branch before opening a pull request — security, SonarQube compliance, performance, and coding standards — and generate PR feedback. Trigger on "/pre-pr-review", "review my changes before I open a PR", "is this ready for a PR", or "review this branch".
---

# Pre-PR Review

Use this skill to review the *changes on the current branch* (not the whole
repository — see `lead-review` for that) before the user opens a pull request, so
issues are caught before a human reviewer or CI sees them.

Read `workflows.md` for the full procedure, `examples.md` for the report shape, and
`best-practices.md` for how to keep feedback actionable instead of noisy.

## When to use this

- The user asks for a review of their current changes / branch / working tree before
  opening a PR.
- The user invokes `/pre-pr-review` directly.
- The user asks "is this ready to merge" or "will this pass Sonar".

## What this produces

**PR feedback** (Markdown) with sections: Changed Files, Security, SonarQube
Compliance, Performance, Coding Standards, and a bottom-line Recommendation
(approve / approve with comments / request changes) — see `examples.md`.

This skill is read-only: it does not modify any files or open the PR itself. If the
user wants a finding fixed first, hand it to the `fix-sonarqube-issues` skill.
