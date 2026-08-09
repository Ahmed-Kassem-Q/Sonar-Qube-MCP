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

When running **under Claude Code**, configuration comes from the `env` block in
`.mcp.json`, which expands `${SONARQUBE_TOKEN}` from your own environment — see
[Per-developer setup](#per-developer-setup-each-teammate-does-this-once).

When running the server **by hand** from `mcp/sonarqube-mcp/`, copy `.env.example`
to `.env` and fill in your values instead. `.env` is git-ignored — never commit real
tokens.

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

`.mcp.json`:

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "node",
      "args": ["mcp/sonarqube-mcp/dist/server.js"],
      "env": {
        "SONARQUBE_URL": "${SONARQUBE_URL:-https://gsonar.alqemam.com}",
        "SONARQUBE_TOKEN": "${SONARQUBE_TOKEN}",
        "SONARQUBE_VERIFY_SSL": "${SONARQUBE_VERIFY_SSL:-true}",
        "MCP_LOG_LEVEL": "${MCP_LOG_LEVEL:-INFO}"
      }
    }
  }
}
```

The server path is **relative to the project root**, which is the working directory
Claude Code launches stdio servers from — so it resolves on every machine with no
per-developer editing. It points at `dist/`, so `npm run build` must have been run.

`MCP_REPO_ROOT` is deliberately **not** set. It defaults to `.` (see `config.ts`),
which is that same project root, so the repository tools sandbox themselves to
whichever checkout Claude was started in. Hardcoding an absolute path here would
point `read_file`/`write_file` at one developer's copy of the repo.

### Per-developer setup (each teammate does this once)

The committed `.mcp.json` contains **no secrets** — `${SONARQUBE_TOKEN}` is expanded
from your own environment, so every developer authenticates as themselves and Sonar
attributes activity to the right user.

1. Generate a personal token at **My Account → Security → Generate Token** on your
   SonarQube server.
2. Export it, so it is set before `claude` starts:

   ```powershell
   setx SONARQUBE_TOKEN "squ_<your-own-token>"      # Windows, persistent
   ```

   ```bash
   export SONARQUBE_TOKEN="squ_<your-own-token>"    # macOS/Linux — add to your shell profile
   ```
3. Restart your terminal (or VS Code) so the new variable is inherited.
4. `npm ci && npm run build` inside `mcp/sonarqube-mcp`.
5. Open the project — `.claude/settings.json` already sets
   `enableAllProjectMcpServers`, so the server connects with no approval prompt.

Every other variable in the table above has a default, so the token is the only one
you must set. If you forget it, the server refuses to start and the error names the
missing variable.

> **Note:** because the `env` block above supplies the settings, the `.env` file inside
> `mcp/sonarqube-mcp/` is **not** read when the server runs under Claude Code —
> `config.ts` loads `.env` relative to the process working directory, which is the
> project root, not the package directory. `.env` only applies when you run
> `npm start` by hand from inside `mcp/sonarqube-mcp`.

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
