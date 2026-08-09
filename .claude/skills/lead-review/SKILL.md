---
name: lead-review
description: Produce a technical-lead-level review of this repository covering architecture, security, performance, maintainability, and technical debt, using the sonarqube-mcp server plus direct repository reading. Trigger on "/lead-review", "technical lead review", "architecture review", "review this codebase like a tech lead", or requests for a technical-debt assessment.
---

# Lead Review

Use this skill to produce the kind of review a technical lead or staff engineer would
write before a major planning cycle, an architecture decision, or an onboarding of new
maintainers: a broad, structured assessment rather than a line-by-line diff review
(see `pre-pr-review` for that).

Read `workflows.md` for the full procedure, `examples.md` for the report shape, and
`best-practices.md` for how to calibrate severity and avoid a report nobody acts on.

## When to use this

- The user asks for an architecture review, a technical-debt assessment, or a
  "how healthy is this codebase" report.
- The user invokes `/lead-review` directly.
- Before a major refactor, a new team member's onboarding, or a "should we rewrite
  this" discussion.

## What this produces

A single **Technical Lead Report** (Markdown) covering, in order: Architecture,
Security, Performance, Maintainability, and Technical Debt, each with concrete
findings tied to specific files/modules — not generic advice. See `examples.md` for
the exact report template.

This skill is read-only: it does not modify any files. If findings should be acted
on, hand specific issues to the `fix-sonarqube-issues` skill afterward.
