# Best practices: pre-pr-review

- **Review the diff in the context of the whole file.** Reading only the hunks misses
  issues like "this new code duplicates a helper already defined 20 lines above."
- **Split Blocking vs. Suggestions explicitly, every time.** A PR review that doesn't
  distinguish "must fix" from "nice to have" trains authors to either ignore
  everything or block on everything.
- **Don't manufacture findings to have something to say.** "No significant findings"
  in a section is a valid and useful result — say it plainly instead of padding with
  minor nitpicks.
- **SonarQube's issue list lags the working tree.** Always caveat that server-side
  SonarQube findings reflect the last analyzed commit, not uncommitted changes — treat
  it as "known issues in this area" context, not a live diff scan.
- **Match existing conventions before calling something a standards violation.** Use
  `search_code` to confirm the pattern you're citing is actually the repo's
  established convention, not just your own preference.
- **This skill is read-only.** Never call `write_file` here. If the user wants the
  Blocking findings fixed, say so explicitly and hand off:
  "Want me to fix the path-traversal issue using the fix-sonarqube-issues skill (or
  directly) before you open the PR?"
- **Keep the Recommendation decisive.** One of Approve / Approve with comments /
  Request changes — not a hedge. If you're genuinely unsure, say what additional
  information (e.g. "does this endpoint require auth in production") would resolve
  the ambiguity, but still commit to a recommendation given what you currently know.
