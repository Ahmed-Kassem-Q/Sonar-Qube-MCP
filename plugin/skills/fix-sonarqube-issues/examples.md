# Examples: fix-sonarqube-issues

## Example 1 — a single issue by key

> **User:** Fix SonarQube issue AYg1abcXYZ123.

1. Call `get_issue_details(issue_key="AYg1abcXYZ123")`.
2. Suppose it reports: rule `python:S5445` (insecure temp file), component
   `my-org_my-repo:src/reports/export.py`, line 42.
3. `read_file(path="src/reports/export.py")`.
4. Explain: the code calls `tempfile.mktemp()`, which is inherently unsafe
   (race condition between name generation and file creation); the fix is to use
   `tempfile.NamedTemporaryFile` / `mkstemp` instead.
5. Show a diff replacing the `mktemp()` call.
6. Ask: *"Apply this fix to `src/reports/export.py`?"*
7. On "yes": `write_file(path="src/reports/export.py", content="<full new file>", confirmed=True)`.
8. Run the project's test command (e.g. `pytest tests/reports/`).
9. Report: issue fixed, tests passed, no further action needed.

## Example 2 — all BLOCKER/CRITICAL issues in a project

> **User:** Clean up all the critical issues in `my-org_my-repo`.

1. `get_critical_issues(project_key="my-org_my-repo")`.
2. Group the results by `rule`. Say there are 3 BLOCKER issues, all
   `java:S2259` (possible null pointer dereference), in three different files.
3. Read each file, and note whether they share a root cause (e.g. all three call a
   helper that can return `null` without checking).
4. Propose 3 diffs (one per file), each adding the appropriate null check.
5. Present all three diffs together and ask for one confirmation covering the batch —
   don't force three separate confirmations for issues the user already asked you to
   batch, but do show every diff before asking.
6. On confirmation, write all three files, then run the build and test suite once.
7. Report: 3/3 fixed, build passed, tests passed.

## Example 3 — an issue you should *not* auto-fix

> **User:** Fix issue AYg1def456 in `payments-service`.

1. `get_issue_details` shows it's a `SECURITY_HOTSPOT` about a hardcoded
   cryptographic key.
2. Reading the file shows the "key" is actually a public, non-secret algorithm
   identifier — a false positive — or, worse, it's a genuine embedded secret that
   needs to be rotated outside of this codebase (not just deleted from the file).
3. In this case: explain the situation clearly, state that this needs a secret
   rotation / security-team decision beyond a code diff, and recommend marking the
   hotspot reviewed in SonarQube (or escalating) rather than proposing a `write_file`
   change that only hides the symptom.

## Sample report (step 10)

```markdown
# SonarQube Fix Report — my-org_my-repo

## Scope
3 BLOCKER issues (rule java:S2259), requested by user on 2026-08-05.

## Fixed
- src/service/OrderProcessor.java:88 — added null check before dereferencing
  `customer.getAddress()`.
- src/service/InvoiceBuilder.java:41 — same pattern, added null check.
- src/service/RefundHandler.java:120 — same pattern, added null check.

## Skipped
None.

## Build
`./gradlew build` — SUCCESS

## Tests
`./gradlew test` — SUCCESS (412 passed, 0 failed)

## Follow-up
Consider adding a `@NonNull` annotation to the helper these three files call, so the
compiler catches this class of issue going forward instead of relying on SonarQube.
```
