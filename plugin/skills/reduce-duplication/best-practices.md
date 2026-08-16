# Best practices: reducing duplication

## Choosing the abstraction

**Extract only what is genuinely duplicated.** The failure mode of a deduplication pass
is a base class with six protected hooks and four boolean flags, created to unify code
that was easier to read when it was repeated. If unifying two blocks requires a
parameter whose only job is to switch between the two, they are not the same code.

Match the mechanism to the shape of the variation:

- **Same algorithm, different data** → a parameterized method or generic.
- **Same skeleton, different steps** → a template method on a base class, or a strategy
  passed in. Prefer composition when the "base class" would only ever have one caller
  per subclass.
- **Same cross-cutting wrapper** (try/catch, logging, transaction, auth check) → move it
  out of the methods entirely: middleware, an exception filter, a decorator, an aspect.
- **Same operations on a type you don't own** → extension methods.
- **Two variants of one feature** → merge and parameterize by the variant, but only if
  the variants are genuinely tracking each other. Two features that happen to look
  alike today will diverge tomorrow, and the merged version will grow flags.

**Rule of three, inverted.** SonarQube flags at two occurrences. That is a signal to
look, not an order to abstract. If the second occurrence exists because the two call
sites are genuinely independent and expected to diverge, the duplication is the correct
design and the metric is wrong about it — say so and exclude it.

## What to leave alone

- **Generated code.** Regeneration overwrites the refactor and reintroduces the metric.
- **Static seed/config data.** Object initializers and lookup tables read as duplication
  to a token-based detector; abstracting them makes the data harder to audit.
- **Test setup.** Explicit, repetitive arrangement is often what makes a test readable
  and independently debuggable. A shared fixture that hides why a test passes costs
  more than the duplication.
- **Code about to be deleted.** Check whether a duplicated module is already slated for
  removal before refactoring it.
- **Cross-boundary duplication.** Two services that duplicate a DTO on purpose to stay
  decoupled should keep duplicating it. Extracting it into a shared package trades a
  duplication metric for a coupling problem.

Whenever you exclude something, record it in the final report with the reason.

## Sequencing and safety

- **One cluster per wave, one wave per commit.** When a measurement fails to move, the
  cost of finding out why is proportional to how much you changed since the last
  measurement.
- **Never mix behavior changes into a deduplication wave.** If you spot a bug in one of
  the duplicated copies — and you often will, because copies drift — stop and raise it.
  Fixing it silently inside the extraction means the wave's diff no longer tells the
  truth, and the fix lands unreviewed. If the copies genuinely differ, that difference
  is a decision for the user, not something to normalize away.
- **Delete, don't just add.** The metric only moves when the redundant bodies are gone.
- **Zero build errors before commit**, and run the tests. Deduplication is a
  behavior-preserving change by definition, so a test failure means the extraction is
  wrong, not that the test needs updating.
- **Look at the git diff before committing.** Large mechanical edits are exactly where
  an unintended deletion hides.

## Measurement discipline

- Score in `duplicated_lines`, not `duplicated_lines_density`. Density moves when
  `ncloc` moves, so a wave that adds a shared class can improve density while removing
  nothing — and a later feature can undo the apparent gain without adding any
  duplication.
- Only report numbers that came back from `get_project_metrics` after analysis. A
  projected saving from the plan is an estimate; do not present it as a result.
- Analysis lags. If the pipeline has not run, report the wave as applied and pending
  measurement rather than guessing.

## Tokens and access

The duplication endpoints are read APIs, and only a **User Token** authenticates them
(My Account → Security → Generate Token). A Project Analysis token or a badge token
will fail with 401/403 even though it works for uploading analysis results. If
`get_duplicated_files` returns an authentication error while `get_projects` works,
suspect a permissions gap on the specific project rather than a bad token.
