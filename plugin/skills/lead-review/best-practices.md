# Best practices: lead-review

- **Every finding needs a receipt.** Cite a file, line, metric, or issue key for each
  claim. "The code has a lot of tech debt" is not a finding; "coverage in
  `notifications/` is 12% vs. 61% repo-wide" is.
- **Separate "risky" from "merely unpleasant."** A security hotspot and an
  inconsistent naming convention are both technical debt, but they don't belong at
  the same priority. Use the Technical Debt Inventory's ordering to make that
  distinction explicit rather than listing everything with equal weight.
- **Don't let SonarQube numbers be the whole story.** SonarQube catches a specific
  class of issue well (rule-based static analysis) and misses architectural and
  product-level concerns entirely. Always pair the metrics with actual reading of
  the code and its structure.
- **Look for clusters, not just counts.** 40 instances of the same rule almost always
  means one systemic fix is more valuable than 40 point fixes — call that out
  explicitly rather than reporting a flat issue count.
- **Calibrate to the audience.** A lead review is usually read by people who will
  make prioritization or staffing decisions from it — write the Executive Summary so
  it stands alone for a reader who won't read the rest.
- **This skill is read-only.** Do not call `write_file` from within a lead review. If
  the user wants a specific finding fixed, hand it off explicitly: "Want me to fix the
  N+1 query in `get_invoice_history` using the fix-sonarqube-issues skill?"
- **Re-check quality-gate-affecting findings against `get_quality_gate`.** If the gate
  is already passing, say so — don't manufacture urgency where SonarQube's own
  configured thresholds say things are fine; focus the review on what the gate
  doesn't (and can't) measure.
