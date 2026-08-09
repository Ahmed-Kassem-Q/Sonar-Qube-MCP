# sonarqube-mcp

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that connects **Claude Code** to **SonarQube** or **SonarCloud**, so Claude
can triage issues, check quality gates, inspect metrics, and drive a confirm-before-write
fix workflow directly against your codebase.

Written in TypeScript on the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and
[zod](https://zod.dev). Runs on Node.js 20.6+ with **two runtime dependencies**.

## What you get

- **6 SonarQube tools** — `get_projects`, `get_project_issues`, `get_critical_issues`,
  `get_quality_gate`, `get_issue_details`, `get_project_metrics`.
- **4 read-only resources** — `sonar://projects`, `sonar://projects/{project_key}`,
  `sonar://projects/{project_key}/issues`, `sonar://projects/{project_key}/metrics`.
- **3 guided prompts** — `sonar_review`, `pr_review`, `fix_issue` — each one a
  step-by-step workflow template for Claude to follow.
- **5 repository tools** — `read_file`, `write_file`, `list_files`, `search_code`,
  `search_files`, sandboxed to a configured repository root. `write_file` refuses to
  write unless called with `confirmed=true`, so Claude cannot modify source code
  without first showing you a diff and getting your explicit go-ahead.
- A reusable **SonarQube client** with token/basic auth, timeouts, pagination,
  and a retry policy for transient failures (network errors, timeouts, HTTP 429/5xx).
- Three **Claude Code skills** (`.claude/skills/`) that build on these tools:
  `fix-sonarqube-issues`, `lead-review`, and `pre-pr-review`.

## Repository layout

```
.
├── .mcp.json                       # Project-scoped MCP server config (auto-discovered by Claude Code)
├── ONBOARDING.md                   # Start here if you are new to the team
├── .claude/
│   ├── settings.json                # Approves the project-scoped MCP server
│   └── skills/
│       ├── fix-sonarqube-issues/    # Retrieve → fix → confirm → apply → build → test → report
│       ├── lead-review/             # Architecture / security / performance / tech-debt report
│       └── pre-pr-review/           # Changed-files review + Sonar compliance + PR feedback
└── mcp/
    └── sonarqube-mcp/               # This package
        ├── package.json
        ├── tsconfig.json
        ├── .env.example
        ├── scripts/setup.mjs         # `npm run setup` — generates .env from the template
        ├── src/
        │   ├── server.ts            # Entry point, McpServer instance, stdio transport
        │   ├── config.ts            # zod-validated configuration, memoized
        │   ├── models.ts            # zod schemas for SonarQube API objects
        │   ├── client.ts            # SonarQube Web API client (auth/retry/pagination)
        │   ├── repoAccess.ts        # Sandboxed filesystem logic behind the repo tools
        │   ├── glob.ts              # Minimal glob matcher (no dependency needed)
        │   ├── tools.ts             # All tool registrations
        │   ├── resources.ts         # All resource registrations
        │   ├── prompts.ts           # All prompt registrations
        │   ├── errors.ts            # Typed error hierarchy
        │   └── logging.ts           # stderr-only logging (stdout is reserved for JSON-RPC)
        └── tests/                   # vitest suite (config, client, repoAccess)
```

## Installation

Requires **Node.js 20.6+**. Nothing else — no global tooling, no runtime to install
separately.

```bash
cd mcp/sonarqube-mcp
npm ci          # install exact locked dependency versions
npm run build   # compile src/ to dist/
```

Use `npm install` instead of `npm ci` if you are intentionally updating dependencies.

## Configuration

Generate `.env` from the template with `npm run setup`, optionally passing credentials
so nothing needs hand-editing:

```bash
cd mcp/sonarqube-mcp
npm run setup                                                    # blanks to fill in
npm run setup -- --url=https://sonar.example.com --token=squ_xxx # ready to use
```

It refuses to overwrite an existing `.env` (pass `--force` to replace it, which backs
the current file up to `.env.bak` first). Credentials you don't pass are written
**blank** rather than as placeholders, so a half-configured server fails immediately
naming the missing variable instead of later with a confusing HTTP 401.

This is deliberately not a `postinstall` hook — writing files into your working tree
as a side effect of `npm ci` is surprising. `cp .env.example .env` by hand works too.

`.env` is git-ignored — never commit real tokens.

The server looks for `.env` in two places, in order: the **current working directory**
(the project root, when launched by Claude Code), then **this package's own
directory**. The second location is why `mcp/sonarqube-mcp/.env` works even though
Claude Code starts the server from the repo root.

Real environment variables always win over `.env`, so you can override any single
value from the shell — or supply everything that way in CI, where writing a file is
awkward.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SONARQUBE_URL` | yes | — | Base URL of your SonarQube server, or `https://sonarcloud.io`. |
| `SONARQUBE_TOKEN` | one of token / user+pass | — | A SonarQube/SonarCloud user token. Recommended over username/password. |
| `SONARQUBE_USERNAME` / `SONARQUBE_PASSWORD` | — | — | Fallback basic-auth credentials, only used if `SONARQUBE_TOKEN` is unset. |
| `SONARQUBE_ORGANIZATION` | SonarCloud only | — | Organization key, required by SonarCloud's API. |
| `SONARQUBE_TIMEOUT_SECONDS` | no | `30` | Per-request HTTP timeout. |
| `SONARQUBE_MAX_RETRIES` | no | `3` | Retry attempts for transient failures (timeouts, connection errors, HTTP 429/5xx). |
| `SONARQUBE_RETRY_BACKOFF_SECONDS` | no | `0.5` | Base for exponential backoff between retries. |
| `SONARQUBE_PAGE_SIZE` | no | `100` | Page size used when paginating `components/search` and `issues/search` (max 500). |
| `SONARQUBE_VERIFY_SSL` | no | `true` | Set to `false` only for trusted self-signed internal servers. See the note below. |
| `MCP_REPO_ROOT` | no | `.` | Directory the repository tools are sandboxed to. Leave unset under Claude Code — the default resolves to the project root. |
| `MCP_MAX_READ_FILE_BYTES` | no | `2000000` | Refuse to read files larger than this. |
| `MCP_MAX_WRITE_FILE_BYTES` | no | `2000000` | Refuse to write content larger than this. |
| `MCP_LOG_LEVEL` | no | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`. Logs go to stderr only. |

Generate a SonarQube/SonarCloud token under **My Account → Security → Generate Token**.

> **`SONARQUBE_VERIFY_SSL=false` is process-wide.** Node's `fetch` has no per-request
> TLS override, so disabling verification sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for
> the whole server process and logs a warning at startup. The process talks to exactly
> one host, so the blast radius is contained — but prefer installing your internal CA
> over using this flag.

## Running the server

Directly, for manual testing over stdio:

```bash
cd mcp/sonarqube-mcp
npm start
```

The process speaks MCP over stdio and will appear to hang with no output — that's
expected; it's waiting for a JSON-RPC client (Claude Code, or the MCP inspector) to
connect on stdin/stdout. Use Ctrl-C to stop it, or inspect it interactively with:

```bash
npx @modelcontextprotocol/inspector node dist/server.js
```

## Connecting Claude Code

This repository ships a project-scoped `.mcp.json` at the repo root plus a
`.claude/settings.json` that approves it, so **Claude Code discovers and connects to
this server automatically** the next time you run `claude` inside this repository —
no manual `claude mcp add` needed.

`.mcp.json` — the entire file:

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "node",
      "args": ["mcp/sonarqube-mcp/dist/server.js"]
    }
  }
}
```

There is **no `env` block, and deliberately so**. Everything configurable lives in each
developer's own `.env`, which keeps three things out of a file that is committed and
shared: tokens, your SonarQube hostname (internal infrastructure worth not publishing),
and any per-machine paths. It also means the file never needs editing — no merge
conflicts on it, ever.

The server path is **relative to the project root**, which is the working directory
Claude Code launches stdio servers from — so it resolves on every machine with no
per-developer editing. It points at `dist/`, so `npm run build` must have been run.

`MCP_REPO_ROOT` is deliberately unset. It defaults to `.` (see `config.ts`), which is
that same project root, so the repository tools sandbox themselves to whichever
checkout Claude was started in. Hardcoding an absolute path would point
`read_file`/`write_file` at one developer's copy of the repo.

### Per-developer setup (each teammate does this once)

Every developer authenticates with their own token, so Sonar attributes activity to the
right user and nobody shares credentials.

1. Generate a personal token at **My Account → Security → Generate Token** on your
   SonarQube server.
2. `cd mcp/sonarqube-mcp && npm run setup -- --url=<your-server> --token=<your-token>`.
   Every other variable has a working default.
3. `npm ci && npm run build`.
4. Open the project — `.claude/settings.json` already sets
   `enableAllProjectMcpServers`, so the server connects with no approval prompt.

If the token is missing, the server refuses to start and the error names the missing
variable rather than failing later with a confusing auth error.

### Making it available in every project

To use the server outside this repository, register it at user scope:

```bash
claude mcp add sonarqube --scope user \
  -e SONARQUBE_URL="$SONARQUBE_URL" \
  -e SONARQUBE_TOKEN="$SONARQUBE_TOKEN" \
  -- node /absolute/path/to/Sonar-Qube-MCP/mcp/sonarqube-mcp/dist/server.js
```

The path must be absolute here, since the server is launched from arbitrary project
roots. User-scope config is stored in `~/.claude.json`, so any token passed with `-e`
is written there in plaintext. Note that a user-scope entry shadows this repository's
`.mcp.json`, so verify team-facing changes to `.mcp.json` with the user-scope entry
removed.

Verify it's connected from inside a `claude` session with `/mcp`, or with
`claude mcp get sonarqube` (which also reports which scope won).

## Example prompts

Once connected, try these inside Claude Code:

```
Use the sonar_review prompt for project "my-org_my-repo".
```

```
What are the critical issues in my-org_my-repo right now, and is its quality gate passing?
```

```
Use fix_issue for issue key AYg1abcXYZ123 — show me the diff before you change anything.
```

```
Run the pr_review prompt comparing main to my current branch.
```

```
Use the fix-sonarqube-issues skill to work through every BLOCKER issue in my-org_my-repo.
```

Or ask ad hoc: *"List all SonarQube projects I have access to"*, *"Show me the metrics
for my-org_my-repo"*, *"Read src/app/main.ts and check it against the SonarQube issues
for this project."*

## Safety model

- `write_file` **always** requires `confirmed=true`. It defaults to `false`, so a
  first call without it fails with a clear error instead of writing anything — Claude is
  expected to show you the issue, its root cause, and a diff, and only retry with
  `confirmed=true` after you approve.
- All repository tools resolve paths against `MCP_REPO_ROOT` and reject anything that
  resolves outside it (path traversal, absolute paths elsewhere on disk). Symlinks are
  fully resolved before the containment check, so a symlink inside the repo cannot be
  used to escape it.
- Reads and writes are size-capped (`MCP_MAX_READ_FILE_BYTES` / `MCP_MAX_WRITE_FILE_BYTES`).
- The three Claude Code skills (see `.claude/skills/`) encode the same
  "propose → confirm → apply → build → test → report" sequence at the workflow level,
  not just at the tool level.

## Development

```bash
cd mcp/sonarqube-mcp
npm ci
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run build     # compile to dist/
npm run dev       # tsc --watch
```

Tests stub the SonarQube HTTP API by injecting a `fetch` implementation (no live
server required) and exercise the repository-sandboxing logic against a temporary
directory.

## Troubleshooting

- **"No SonarQube credentials configured"** — set `SONARQUBE_TOKEN` (or
  `SONARQUBE_USERNAME`+`SONARQUBE_PASSWORD`) in your environment, or in `.env` if
  running the server by hand.
- **`Cannot find module .../dist/server.js`** — you haven't built yet. Run
  `npm ci && npm run build` in `mcp/sonarqube-mcp`.
- **HTTP 401/403 from every tool** — the token is invalid, expired, or lacks
  permission on the target project(s).
- **SonarCloud requests failing with an organization error** — set
  `SONARQUBE_ORGANIZATION`.
- **`write_file` always errors** — this is intentional until you pass
  `confirmed=true`; see "Safety model" above.
- **Claude Code shows the server as "Pending approval"** — run `claude` once
  interactively in this repo and accept the workspace trust / project-server
  approval prompt (or check `enableAllProjectMcpServers` in `.claude/settings.json`).
