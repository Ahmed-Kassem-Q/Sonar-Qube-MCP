# Workflow: reduce-duplication

## Phase 0. Establish scope

Confirm the SonarQube project key and which branch is analyzed. If the user names a
repository but not a key, use `get_projects` with a substring of the repo name.

Note which branch SonarQube analyzes. If it only analyzes `main`, the measurements in
Phase 6 will not move until the wave is merged — say so up front rather than reporting
a "failed" wave later.

## Phase 1. Collect the ground-truth baseline

Record the starting numbers before changing anything:

```
get_project_metrics(
  project_key="...",
  metric_keys=["duplicated_lines", "duplicated_lines_density",
               "duplicated_blocks", "duplicated_files", "ncloc"]
)
```

Write these down explicitly in your reply — every later wave is measured against them.

- **`duplicated_lines`** — the primary target. Waves are scored in this number.
- **`duplicated_lines_density`** — secondary. It is `duplicated_lines / ncloc`, so it
  also moves when code volume changes; never report density alone as evidence a
  refactor worked.
- **`duplicated_blocks`** — how many distinct duplicate groups exist.
- **`duplicated_files`** — how wide the problem is.

Then rank the files:

```
get_duplicated_files(project_key="...", max_results=50)
```

This returns files sorted by `duplicated_lines`, highest first. Duplication is almost
always heavily concentrated — expect a short head of files to hold most of the total.

## Phase 2. Validate the top contributors

For each candidate, in rank order:

```
get_file_duplications(component_key="<project_key>:src/path/File.cs")
```

The component key is the `key` field from `get_duplicated_files` (also the `component`
field on an issue). Each result is a group of blocks; every block gives a
`componentKey` and a `from`/`size` line range, so you can see both sides of the match.

Then `read_file` the actual ranges on both sides and decide:

**Genuine target — include:**

- Copy-paste logic: the same algorithm operating on different data.
- Repeated boilerplate: handlers, controllers, components built to one template.
- A feature implemented twice for two variants (e.g. per role, per tenant).

**False target — exclude:**

- Static seed data, object initializers, config enums, large literal tables.
- Generated code — structural repetition is expected and regenerating overwrites you.
- Test fixtures where the repetition is the point (each test stating its own setup
  explicitly is usually better than a shared helper that hides it).

Say explicitly which candidates you excluded and why. An excluded file still counts
toward the metric, so the plan's projected total must not include it.

## Phase 3. Group into refactor clusters

Group the confirmed findings by refactor *shape*, not by folder. Common shapes:

| Duplication shape | Typical location | Fix strategy | Effort | Risk |
|---|---|---|---|---|
| Repeated method/handler boilerplate | Query/command handlers | Extract an abstract base class | Low | Low |
| A feature folder duplicated per variant | `src/requester/` vs `src/beneficiary/` | Merge and parameterize by role | Medium | Low |
| Repeated try/catch in every action | 20+ controller methods | Move to middleware / exception filter | Low | Very low |
| Repeated CRUD / soft-delete patterns | Repository methods | Push into extension methods or a generic base repo | Very low | Very low |
| Repeated validation or mapping snippets | DTO projections | Extract a helper or mapper profile | Low | Low |

A cluster is a unit of work with one abstraction at its centre. If you cannot name the
single thing being extracted, the cluster is really two clusters.

## Phase 4. Build the refactor plan

Present a prioritized table, ranked by confirmed lines eliminated:

| Rank | Cluster | Files | Duplicated lines | Fix shape | Effort | Risk |
|---|---|---|---|---|---|---|
| 1 | Component trees | 8 | 4,830 | Parameterize by role | Medium | Low |
| 2 | Report generators | 3 | 1,115 | Extract shell service | Low | Low |
| 3 | Query handlers | 2 | 640 | Base class | Low | Low |

Sanity-check the total against the Phase 1 baseline. It will not match exactly — blocks
are counted on both sides and some files are excluded — but a plan claiming to remove
more lines than the baseline holds means something has been double-counted.

Get the user's agreement on the ordering before starting. Ranking by lines is the
default, but a user may prefer to start with a low-risk cluster to prove the loop.

## Phase 5. Execute one wave

For the top cluster only:

1. **Read and design.** Read every file in the cluster in full. Separate what is
   genuinely identical from what varies, and decide how variation is expressed —
   parameter, template method, injected strategy, or generic type argument.
2. **Draft the change.** Write the shared abstraction, update every caller, delete the
   redundant blocks. Deleting is the step that moves the metric; a "refactor" that adds
   a base class while leaving the original bodies in place changes nothing.
3. **Show the whole wave as a diff and stop.** Wait for explicit approval.
4. **Apply** with `write_file(..., confirmed=True)`, one file at a time.
5. **Build and test.** Run the repository's build and test commands. Zero build errors
   is a hard gate — do not commit or move on with a broken build.
6. **Review the diff** (`git diff`) for accidental deletions before committing.
7. **Commit the wave on its own:**

```
Wave N: <cluster name> — remove <X> lines of duplication

- Extract <SharedClass/BaseClass/Service>
- Refactor <File1, File2, File3>
- Build: clean; tests: passing
```

## Phase 6. Measure after the wave

Re-run the Phase 1 metrics call and report the delta against baseline and against the
previous wave:

```
Wave 0 (baseline):  duplicated_lines = 12,547
Wave 1 (complete):  duplicated_lines =  7,717   (-4,830, 38% down)
Wave 2 (complete):  duplicated_lines =  6,602   (-1,115, 14% down from wave 1)
```

If the number has not moved, work through the causes in order before assuming the
refactor failed:

1. SonarQube has not re-analyzed yet — analysis runs on CI, so wait for the pipeline.
2. The wave is on a branch SonarQube does not analyze, or is not merged.
3. The extraction landed but the duplicated bodies were not actually deleted.
4. The blocks were near a detection threshold, and shrinking them moved the duplication
   elsewhere rather than removing it.

Report which of these it was. Never restate the plan's projected number as if it were
the measured result.

Then return to Phase 5 for the next cluster.

## Phase 7. Final report

When the clusters are done, summarize:

```
PROJECT: <key>
Baseline:            12,547 duplicated lines  (8.4% density)
After all waves:      4,878 duplicated lines  (3.3% density)
Eliminated:           7,669 lines  (61% reduction)
Waves: 3 | Files changed: 24 | Build: clean | Tests: passing
```

Include what was deliberately left alone and why, so the next person does not
re-litigate the same excluded files.
