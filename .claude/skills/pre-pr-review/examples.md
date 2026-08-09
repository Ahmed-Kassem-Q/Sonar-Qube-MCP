# Examples: pre-pr-review

## Example — invocation

> **User:** Review my changes before I open a PR. Base branch is `main`.

1. `git diff --name-only main...HEAD` (via your shell tool) → say it returns
   `src/api/routes/export.py`, `src/api/routes/tests/test_export.py`.
2. `read_file` both in full.
3. `get_project_issues(project_key="my-org_my-repo", status="OPEN")`, filter to
   issues whose `component` matches `src/api/routes/export.py` — say there's one
   pre-existing MAJOR `CODE_SMELL` on a line the diff didn't touch (mention it, don't
   block on it) and no new issues on the changed lines specifically.
4. Produce PR feedback:

```markdown
# PR Feedback — export endpoint changes

**Base:** main → **Head:** HEAD (2 files changed)

## Changed Files
- `src/api/routes/export.py` (+38 / -6)
- `src/api/routes/tests/test_export.py` (+52 / -0)

## Security
- **Blocking:** `export.py:61` builds a filesystem path from the `filename` query
  parameter with no sanitization (`os.path.join(EXPORT_DIR, filename)`), allowing
  path traversal (`?filename=../../etc/passwd`). Validate/normalize and confirm the
  resolved path stays under `EXPORT_DIR` before use.

## SonarQube Compliance
- No new issues introduced on the changed lines.
- Pre-existing MAJOR CODE_SMELL on `export.py:14` (unrelated to this diff, rule
  S3776 cognitive complexity) — not blocking, but worth a follow-up ticket since
  this file is clearly getting touched again.

## Performance
- No concerns — the new code path is a single bounded read, no loops over
  unbounded input.

## Coding Standards
- **Suggestion:** every other handler in `routes/` raises `HTTPException` with a
  structured error body (see `routes/import.py:22`); this new handler returns a bare
  string on the 400 path (`export.py:70`). Match the existing pattern for
  consistency.
- Tests: good coverage of the happy path and the missing-file case; consider adding
  a case for the path-traversal input once the security fix above lands.

## Recommendation
**Request changes** — the path traversal issue must be fixed before merge. Everything
else is a suggestion, not a blocker.
```

## Calibrating the recommendation

- **Approve** — no blocking findings; suggestions only, or none.
- **Approve with comments** — no blocking findings, but suggestions worth the author
  seeing before or shortly after merge.
- **Request changes** — at least one Blocking finding (security issue, correctness
  bug, or a SonarQube issue that would fail the quality gate).
