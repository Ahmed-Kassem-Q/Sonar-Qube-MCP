---
name: reduce-duplication
description: Systematically reduce code duplication in a SonarQube-tracked project using the sonarqube-mcp server. Pulls a ground-truth baseline, ranks the worst files, confirms exact duplicated blocks, groups them into refactor clusters, then executes one confirmed wave at a time and re-measures after each. Trigger on "/reduce-duplication", "reduce code duplication", "fix duplicated code", "duplication is too high", "our duplication density failed the quality gate", or a request to refactor copy-paste code in a Sonar project.
---

# Reduce Code Duplication

Use this skill to drive duplication down in a measurable, repeatable way. It depends on
the `sonarqube-mcp` MCP server being connected (check with `/mcp` — it should be named
`sonarqube`).

Read `workflows.md` for the full phase-by-phase procedure, `examples.md` for a worked
run, and `best-practices.md` for how to choose an abstraction and which duplication to
leave alone.

## When to use this

- The quality gate fails on `duplicated_lines_density`, or duplication is called out in
  a review.
- The user asks to remove copy-paste code, deduplicate a module, or "clean up the
  duplication" in a project.
- The user invokes `/reduce-duplication` directly.

## The governing rule: Sonar data, not pattern matching

**Never pick refactor targets by reading code and judging that two things look similar.**
Start from `get_duplicated_files`, and confirm every target with
`get_file_duplications` before touching it. Similar-looking code is not what the metric
counts; only SonarQube's detected blocks are. A refactor chosen by eye routinely
produces a large diff and a duplication number that has not moved.

## Confirm before writing

This skill applies source changes, so the `write_file` confirmation gate applies in
full: show the proposed diff, wait for explicit approval, then call `write_file` with
`confirmed=True`. A wave is typically several files — show the whole wave's diff and
get one explicit go-ahead before applying any of it. Never skip the gate.

## Quick procedure (see workflows.md for detail)

1. **Baseline** — `get_project_metrics` and record `duplicated_lines`,
   `duplicated_lines_density`, `duplicated_blocks`, `duplicated_files`, `ncloc`.
   `duplicated_lines` is the number you are driving down.
2. **Rank** — `get_duplicated_files` to find which files carry the burden.
3. **Validate** — `get_file_duplications` on each top candidate to see the exact line
   ranges and their partner files. Discard false targets (seed data, generated code,
   config literals).
4. **Cluster** — group confirmed duplication by refactor shape, not by directory.
5. **Plan** — a prioritized table ranked by confirmed lines eliminated; the sum should
   roughly reconcile to the baseline.
6. **Execute one wave** — extract the shared abstraction, update callers, delete the
   redundant blocks, build clean, test, and commit that wave on its own.
7. **Re-measure** — re-run step 1 after the branch is analyzed, and report the delta.
   Repeat from step 6 for the next cluster.

Do not start a second cluster before the first is committed and measured. Waves exist
so that when a number fails to move, you know exactly which change to look at.
