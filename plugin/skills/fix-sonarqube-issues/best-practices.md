# Best practices: fix-sonarqube-issues

- **One logical change per confirmation round.** Batch mechanically-identical fixes
  (same rule, same pattern) into one confirmation; keep unrelated fixes in separate
  rounds so the user can approve/reject independently.
- **Read before you write, every time.** Never reconstruct a file's content from
  memory or from the diff hunk alone — always `read_file` immediately before building
  the new content, in case the file changed since you last looked at it.
- **Prefer the narrowest fix that actually addresses the root cause.** Don't use a
  SonarQube issue as an excuse to refactor broadly — that increases review burden and
  risk, and buries the actual fix.
- **Don't suppress, silence.** If a rule genuinely doesn't apply (a false positive),
  say so explicitly and explain why, rather than adding a blanket suppression
  (`// NOSONAR`, `# noqa`, etc.) as a first resort. If suppression really is correct,
  propose it as the diff and explain the reasoning — that's still a change that needs
  confirmation.
- **Security issues need extra scrutiny, not extra speed.** For `VULNERABILITY` and
  `SECURITY_HOTSPOT` types, prefer flagging for human security review over a
  fast automated patch when the right fix isn't a small, obviously-correct diff (see
  Example 3 in `examples.md`). Never fix a hardcoded-secret finding by simply deleting
  the visible secret — the secret must be rotated/revoked wherever it grants access,
  which is outside what a file edit can accomplish.
- **Re-run tests, don't assume.** A fix that "should" work can still break behavior
  the tests actually cover. Always run the test suite (or the most relevant subset)
  after applying a change, and treat a resulting failure as a new issue that goes
  back through the confirmation gate, not something to patch silently.
- **Keep the report honest about partial success.** If 8 of 10 targeted issues were
  fixed, say 8 of 10 — don't imply full completion. List the 2 skipped issues and why.
- **Respect `MCP_REPO_ROOT` sandboxing.** If `read_file`/`write_file`/`search_code`
  reject a path as outside the repository root, that's the server protecting the
  user — don't try to work around it (e.g. by shelling out directly to write files);
  tell the user the path is out of scope for this server's configured root.
