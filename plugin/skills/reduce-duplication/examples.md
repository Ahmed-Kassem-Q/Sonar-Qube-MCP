# Examples: reduce-duplication

## A full first pass

> **User:** our duplication density just failed the quality gate on qGEO-EP-BE. can you sort it out?

**Claude:** Pulling the baseline before I change anything.

*Calls `get_project_metrics(project_key="qGEO-EP-BE", metric_keys=[...])`.*

```
duplicated_lines          12,547
duplicated_lines_density  8.4%
duplicated_blocks         418
duplicated_files          63
ncloc                     149,370
```

*Calls `get_duplicated_files(project_key="qGEO-EP-BE", max_results=50)`.*

Duplication is concentrated — the top 13 files hold about 6,600 of the 12,547 lines:

| File | Duplicated lines |
|---|---|
| `src/requester/RequestTree.tsx` | 812 |
| `src/beneficiary/RequestTree.tsx` | 806 |
| `src/Services/MonthlyReport.cs` | 402 |
| … | … |

*Calls `get_file_duplications` on the top entries.*

Confirmed: the two `RequestTree.tsx` files match at 8 blocks covering nearly the whole
component; the three report services share an identical build-header / build-footer /
stream-to-response shell around genuinely different body logic.

One exclusion: `src/Data/CountrySeed.cs` shows 240 duplicated lines, but
`get_file_duplications` shows the match is against `RegionSeed.cs` and both are literal
object initializers. That is static data, not logic — I've left it out of the plan, so
the plan targets fewer lines than the baseline.

Here's the proposed order:

| Rank | Cluster | Files | Lines | Fix | Risk |
|---|---|---|---|---|---|
| 1 | Request tree components | 8 | 4,830 | Merge, parameterize by role | Low |
| 2 | Report generators | 3 | 1,115 | Extract shell service | Low |
| 3 | Query handlers | 2 | 640 | Base class | Low |

Shall I start with wave 1?

> **User:** yes

**Claude:** *Reads all 8 files, then shows the full wave diff — a single
`RequestTree.tsx` taking a `role` prop, the eight call sites updated, the duplicates
deleted.*

That's the whole wave. Applying it deletes 7 files and rewrites 6. Approve?

> **User:** go ahead

*Applies each file with `write_file(..., confirmed=True)`, runs `npm run build` and
`npm test`, reviews `git diff`, commits as `Wave 1: request tree components — remove
4,830 lines of duplication`.*

Build clean, 214 tests passing. Committed. CI needs to run before Sonar re-measures —
I'll check once it's green.

---

## When the number doesn't move

> **User:** ok CI is green, what's the number?

**Claude:** *Re-runs `get_project_metrics`.*

```
duplicated_lines  12,547 → 12,547   (no change)
```

Before assuming the wave failed: analysis ran on `feature/dedupe-wave-1`, and this
project's Sonar analysis is configured for `main` only. The 4,830 lines are gone from
the branch but Sonar is still measuring `main`.

Two options — merge wave 1 and measure, or keep going on the branch and measure once at
the end. I'd merge now: measuring per wave is the whole point of splitting them, and if
wave 1's real number comes back different from the projected 4,830, that changes how
much to trust the estimates for waves 2 and 3.

---

## Pushing back on a target

> **User:** ProductDto and ProductSummaryDto are 90% the same, merge them

**Claude:** *Calls `get_file_duplications` on both.*

Sonar does flag these — one block, 34 lines, the shared property list.

I'd leave it. They're separate on purpose: `ProductSummaryDto` is the list-endpoint
projection and `ProductDto` is the detail response. Merging them means the list
endpoint starts serializing fields it doesn't need, or grows nullable fields and a
"which mode am I in" flag. That's 34 lines of metric traded for a coupling between two
API contracts that should be free to diverge.

If you want these lines off the board anyway, the safer version is extracting the shared
properties into a base record that both inherit — same reduction, no contract coupling.
Want me to do that instead, or move on to wave 2?
