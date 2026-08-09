# sonarqube-mcp

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that connects **Claude Code** to **SonarQube** or **SonarCloud**, so Claude
can triage issues, check quality gates, inspect metrics, and drive a confirm-before-write
fix workflow directly against your codebase.

Built with the official [MCP Python SDK](https://github.com/modelcontextprotocol/python-sdk),
`httpx`, and `pydantic`.

## What you get

- **6 SonarQube tools** — `get_projects`, `get_project_issues`, `get_critical_issues`,
  `get_quality_gate`, `get_issue_details`, `get_project_metrics`.
- **4 read-only resources** — `sonar://projects`, `sonar://projects/{project_key}`,
  `sonar://projects/{project_key}/issues`, `sonar://projects/{project_key}/metrics`.
- **3 guided prompts** — `sonar_review`, `pr_review`, `fix_issue` — each one a
  step-by-step workflow template for Claude to follow.
- **5 repository tools** — `read_file`, `write_file`, `list_files`, `search_code`,
  `search_files`, sandboxed to a configured repository root. `write_file` refuses to
  write unless called with `confirmed=True`, so Claude cannot modify source code
  without first showing you a diff and getting your explicit go-ahead.
- A reusable async **SonarQube client** with token/basic auth, timeouts, pagination,
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
    └── sonarqube-mcp/                # This package
        ├── pyproject.toml
        ├── .env.example
        ├── src/sonarqube_mcp/
        │   ├── server.py             # Entry point, MCPServer instance, typed lifespan
        │   ├── config.py             # pydantic-settings configuration
        │   ├── models.py             # Pydantic models for SonarQube API objects
        │   ├── client.py             # Async SonarQube Web API client (auth/retry/pagination)
        │   ├── repo_access.py        # Sandboxed filesystem logic behind the repo tools
        │   ├── tools.py              # All @mcp.tool() definitions
        │   ├── resources.py          # All @mcp.resource() definitions
        │   ├── prompts.py            # All @mcp.prompt() definitions
        │   ├── exceptions.py         # Typed exception hierarchy
        │   └── logging.py            # stderr-only logging (stdout is reserved for JSON-RPC)
        └── tests/                     # pytest suite (config, client, repo_access)
```

## Installation

Requires **Python 3.12+** and [`uv`](https://docs.astral.sh/uv/).

```bash
cd mcp/sonarqube-mcp
uv sync                 # creates .venv and installs runtime + dev dependencies
```

Without `uv`, a standard virtualenv also works:

```bash
cd mcp/sonarqube-mcp
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

## Configuration

When running the server **under Claude Code**, configuration comes from the `env` block
in `.mcp.json`, which expands `${SONARQUBE_TOKEN}` from your own environment — see
[Per-developer setup](#per-developer-setup-each-teammate-does-this-once).

When running it **by hand** from `mcp/sonarqube-mcp/`, copy `.env.example` to `.env`
and fill in your values instead. `.env` is git-ignored — never commit real tokens.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SONARQUBE_URL` | yes | — | Base URL of your SonarQube server, or `https://sonarcloud.io`. |
| `SONARQUBE_TOKEN` | one of token / user+pass | — | A SonarQube/SonarCloud user token. Recommended over username/password. |
| `SONARQUBE_USERNAME` / `SONARQUBE_PASSWORD` | — | — | Fallback basic-auth credentials, only used if `SONARQUBE_TOKEN` is unset. |
| `SONARQUBE_ORGANIZATION` | SonarCloud only | — | Organization key, required by SonarCloud's API. |
| `SONARQUBE_TIMEOUT_SECONDS` | no | `30` | Per-request HTTP timeout. |
| `SONARQUBE_MAX_RETRIES` | no | `3` | Retry attempts for transient failures (timeouts, connection errors, HTTP 429/5xx). |
| `SONARQUBE_RETRY_BACKOFF_SECONDS` | no | `0.5` | Base for exponential backoff between retries. |
| `SONARQUBE_PAGE_SIZE` | no | `100` | Page size used when paginating `projects/search` and `issues/search` (max 500). |
| `SONARQUBE_VERIFY_SSL` | no | `true` | Set to `false` only for trusted self-signed internal servers. |
| `MCP_REPO_ROOT` | no | `.` | Directory the repository tools are sandboxed to. Leave unset under Claude Code — the default resolves to the project root. |
| `MCP_MAX_READ_FILE_BYTES` | no | `2000000` | Refuse to read files larger than this. |
| `MCP_MAX_WRITE_FILE_BYTES` | no | `2000000` | Refuse to write content larger than this. |
| `MCP_LOG_LEVEL` | no | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR`, or `CRITICAL`. Logs go to stderr only. |

Generate a SonarQube/SonarCloud token under **My Account → Security → Generate Token**.

## Running the server

Directly, for manual testing over stdio:

```bash
cd mcp/sonarqube-mcp
uv run sonarqube-mcp
```

The process speaks MCP over stdio and will appear to hang with no output — that's
expected; it's waiting for a JSON-RPC client (Claude Code, or the MCP inspector) to
connect on stdin/stdout. Use Ctrl-C to stop it, or inspect it interactively with:

```bash
npx @modelcontextprotocol/inspector uv run sonarqube-mcp
```

## Connecting Claude Code

This repository already ships a project-scoped `.mcp.json` at the repo root (see
below) plus a `.claude/settings.json` that approves it, so **Claude Code discovers
and connects to this server automatically** the next time you run `claude` inside
this repository — no manual `claude mcp add` needed.

`.mcp.json`:

```json
{
  "mcpServers": {
    "sonarqube": {
      "command": "uv",
      "args": [
        "--directory",
        "mcp/sonarqube-mcp",
        "run",
        "sonarqube-mcp"
      ],
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

The `--directory` path is **relative to the project root**, which is the working
directory Claude Code launches stdio servers from — so it resolves on every machine
with no per-developer editing.

`MCP_REPO_ROOT` is deliberately **not** set. It defaults to `.` (see `config.py`),
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
4. `uv sync` inside `mcp/sonarqube-mcp` to create the virtualenv.
5. Open the project — `.claude/settings.json` already sets
   `enableAllProjectMcpServers`, so the server connects with no approval prompt.

Every other variable in the table above has a default, so the token is the only one
you must set. If you forget it, the server refuses to start and the error names the
missing variable.

> **Note:** because the `env` block above supplies the settings, the `.env` file inside
> `mcp/sonarqube-mcp/` is **not** read when the server runs under Claude Code —
> `config.py` loads `.env` relative to the process working directory, which is the
> project root, not the package directory. `.env` only applies when you run
> `uv run sonarqube-mcp` by hand from inside `mcp/sonarqube-mcp`.

### Making it available in every project

To use the server outside this repository, register it at user scope:

```bash
claude mcp add sonarqube --scope user \
  -e SONARQUBE_URL="$SONARQUBE_URL" \
  -e SONARQUBE_TOKEN="$SONARQUBE_TOKEN" \
  -- uv --directory /absolute/path/to/Sonar-Qube-MCP/mcp/sonarqube-mcp run sonarqube-mcp
```

The `--directory` must be absolute here, since the server is launched from arbitrary
project roots. User-scope config is stored in `~/.claude.json`, so any token passed
with `-e` is written there in plaintext. Note that a user-scope entry shadows this
repository's `.mcp.json`, so verify team-facing changes to `.mcp.json` with the
user-scope entry removed.

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
for my-org_my-repo"*, *"Read src/app/main.py and check it against the SonarQube issues
for this project."*

## Safety model

- `write_file` **always** requires `confirmed=True`. It is `False` by default, so a
  first call without it raises a clear error instead of writing anything — Claude is
  expected to show you the issue, its root cause, and a diff, and only retry with
  `confirmed=True` after you approve.
- All repository tools resolve paths against `MCP_REPO_ROOT` and reject anything that
  resolves outside it (path traversal, absolute paths elsewhere on disk).
- Reads and writes are size-capped (`MCP_MAX_READ_FILE_BYTES` / `MCP_MAX_WRITE_FILE_BYTES`).
- The three Claude Code skills (see `.claude/skills/`) encode the same
  "propose → confirm → apply → build → test → report" sequence at the workflow level,
  not just at the tool level.

## Development

```bash
cd mcp/sonarqube-mcp
uv sync
uv run pytest
uv run ruff check src tests
uv run mypy src
```

Tests mock the SonarQube HTTP API (no live server required) and exercise the
repository-sandboxing logic against a temporary directory.

## Troubleshooting

- **"No SonarQube credentials configured"** — set `SONARQUBE_TOKEN` (or
  `SONARQUBE_USERNAME`+`SONARQUBE_PASSWORD`) in `.env` or your shell environment.
- **HTTP 401/403 from every tool** — the token is invalid, expired, or lacks
  permission on the target project(s).
- **SonarCloud requests failing with an organization error** — set
  `SONARQUBE_ORGANIZATION`.
- **`write_file` always errors** — this is intentional until you pass
  `confirmed=True`; see "Safety model" above.
- **Claude Code shows the server as "Pending approval"** — run `claude` once
  interactively in this repo and accept the workspace trust / project-server
  approval prompt (or check `enableAllProjectMcpServers` in `.claude/settings.json`).
