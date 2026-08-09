# Examples: lead-review

## Example — invocation

> **User:** Can you do a lead review of the `payments-service` repo? SonarQube
> project key is `my-org_payments-service`.

Work through `workflows.md` steps 1-8, then produce a report shaped like this:

```markdown
# Technical Lead Report — payments-service

_Generated 2026-08-05. SonarQube project: my-org_payments-service._

## Executive Summary
2-4 sentences: overall health, the single biggest risk, and the single biggest
maintainability win, in plain language a non-engineering stakeholder could follow.

## Architecture
- **Finding:** The `billing` and `notifications` modules both import directly from
  `internal/db/models`, bypassing the `billing/repository` abstraction that exists
  for exactly this purpose (`src/notifications/sender.py:12`, `:45`).
  **Impact:** Schema changes now require touching two module boundaries instead of
  one; the repository abstraction is effectively dead weight in its current form.
  **Recommendation:** Route `notifications` through `billing/repository`, or dissolve
  the abstraction if it's not earning its keep anywhere.

## Security
- **Finding:** SonarQube reports 2 open SECURITY_HOTSPOT issues
  (rules S4830, S5344) in `src/auth/verify.py`, both around certificate validation.
  **Impact:** Potential MITM exposure if these are genuine (not yet triaged in
  SonarQube).
  **Recommendation:** Prioritize triage of these two hotspots this sprint; do not
  treat "SonarQube hasn't flagged more" as "there is nothing else" — a manual skim
  of `src/auth/` found no additional issues, but it's a small surface area.

## Performance
- **Finding:** `get_invoice_history` (`src/billing/queries.py:88`) issues one DB
  query per line item inside a loop (N+1).
  **Impact:** Response time scales linearly with invoice line-item count; this
  endpoint is already the slowest in APM (context provided by user, not visible to
  this review) at high line-item counts.
  **Recommendation:** Batch into a single query with an `IN` clause or a join.

## Maintainability
- Coverage: 61% (from get_project_metrics), concentrated in `billing/`; `notifications/`
  has 12% coverage.
- Duplication: 8.4% duplicated lines, mostly between `sender.py` and `retry_sender.py`
  (near-identical retry logic implemented twice).
- 34 open CODE_SMELL issues, 19 of which are rule S3776 (cognitive complexity) — a
  pattern, not 19 unrelated problems; several large `if/elif` chains could become
  a dispatch table or strategy pattern.

## Technical Debt Inventory (prioritized)
1. N+1 query in `get_invoice_history` — high user-facing impact, low effort to fix.
2. Two open security hotspots in `verify.py` — needs triage now, fix effort unknown
   until triaged.
3. Duplicated retry logic between `sender.py`/`retry_sender.py` — medium effort,
   unlocks easier future changes.
4. `notifications/` test coverage — needs investment before further changes there.
5. `billing`/`notifications` module boundary violation — lower urgency, worth fixing
   opportunistically alongside other `notifications` work.
```

Adjust section depth to what you actually found — an empty section should say
"No significant findings" rather than being omitted (so the reader knows it was
checked, not skipped).
