# Getting started with the SonarQube MCP server

A guide for a developer joining the team. It assumes you have never used MCP or
Claude Code before. Budget about 15 minutes.

---

## 1. What this actually is

Claude Code normally can't see our SonarQube server. This project is a small
**MCP server** — a helper process that Claude Code starts in the background and
talks to over stdin/stdout. It gives Claude two kinds of ability:

- **Read SonarQube** — list projects, pull issues, check quality gates, read metrics.
- **Read and write files in this repo** — so it can look at the code an issue points
  at, and propose an actual fix.

You never run this server yourself or interact with it directly. Claude starts it,
uses it, and shuts it down. Your job is a one-time setup so it can authenticate
**as you**.

Why as you: every SonarQube call is made with your personal token, so activity is
attributed to you and you only see projects you already have permission to see.
Nobody shares a token.

---

## 2. Prerequisites

| Tool | Check | If missing |
|---|---|---|
| Python 3.12+ | `python --version` | [python.org](https://www.python.org/downloads/) |
| `uv` | `uv --version` | `winget install astral-sh.uv` (or see [docs](https://docs.astral.sh/uv/)) |
| Claude Code | `claude --version` | Install the VS Code extension or CLI |

`uv` is the Python package manager this project uses. It handles the virtualenv for
you — you will not need to activate anything manually.

---

## 3. Setup (once)

### 3.1 Clone

```bash
git clone <repo-url>
cd sonarqube-mcp-project_1
```

Keep the directory structure as-is. The server is located by a path relative to the
repo root, so moving folders around will break it.

### 3.2 Get your own SonarQube token

1. Open <https://gsonar.alqemam.com> and sign in.
2. Click your avatar → **My Account** → **Security**.
3. Under **Generate Tokens**, name it something like `claude-code-<yourname>`, choose
   type **User Token**, and click **Generate**.
4. **Copy it now.** SonarQube shows the value exactly once; if you lose it you have to
   revoke and generate a new one.

It looks like `squ_` followed by a long hex string.

### 3.3 Put the token in your environment

The token lives in *your* environment, never in the repo. On Windows:

```powershell
setx SONARQUBE_TOKEN "squ_your_token_here"
```

macOS/Linux — add this to `~/.zshrc` or `~/.bashrc`:

```bash
export SONARQUBE_TOKEN="squ_your_token_here"
```

**Then fully restart VS Code** (or your terminal). `setx` only affects processes
started *after* it runs, so an already-open editor will not see it. This is the single
most common setup failure.

### 3.4 Install dependencies

```bash
cd sonarqube-mcp-project_1/mcp/sonarqube-mcp
uv sync
```

This creates `.venv/` and installs everything from the locked versions in `uv.lock`.

### 3.5 Verify

Open the repo in Claude Code and run:

```
/mcp
```

You want to see `sonarqube` listed as **connected**. If so, you're done — skip to
section 4.

---

## 4. Using it

You don't call tools by name. You ask in plain language and Claude picks the tool.
Start with:

```
List all the SonarQube projects I have access to.
```

That confirms your token works end to end. From there:

```
What are the critical issues in <project-key> right now, and is the quality gate passing?
```

```
Show me the metrics for <project-key> — coverage, duplications, and technical debt.
```

```
Read the file that issue AYg1abcXYZ123 points at and explain why Sonar flagged it.
```

### The skills

Three packaged workflows live in `.claude/skills/`. Invoke them by name with a `/`:

| Command | What it does |
|---|---|
| `/fix-sonarqube-issues` | Pulls issues, locates the code, proposes a fix, **waits for your approval**, applies it, builds, tests, and writes a report. |
| `/lead-review` | Architecture, security, performance and technical-debt review of the whole repo. |
| `/pre-pr-review` | Reviews just your branch's changed files before you open a PR. |

These are the main reason the project exists — prefer them over ad-hoc prompting for
anything beyond a quick lookup.

### The safety rule you should know about

Claude **cannot silently edit your files**. The `write_file` tool refuses to write
unless it is called with an explicit confirmation flag, and it is only allowed to set
that flag after showing you a diff and getting your go-ahead. If you ever see a file
change you didn't approve, that's a bug worth reporting.

File access is also sandboxed to the repo you have open — Claude can't read or write
elsewhere on your disk through these tools.

---

## 5. When something breaks

**`/mcp` doesn't list `sonarqube`, or shows it as failed**
Almost always the token variable isn't visible to the editor. In a *fresh* terminal:
`echo $env:SONARQUBE_TOKEN` (PowerShell) or `echo $SONARQUBE_TOKEN`. If it's empty,
redo step 3.3 and restart VS Code completely. If it prints correctly, run
`claude mcp get sonarqube` for the connection error.

**"No SonarQube credentials configured"**
Same cause — the server started without the variable set.

**Every tool returns 401 or 403**
The token is wrong, expired, revoked, or you lack permission on that project. Generate
a fresh one and redo step 3.3.

**`uv: command not found`**
`uv` isn't installed or isn't on PATH. Reinstall it and open a new terminal.

**You edited `.env` and nothing changed**
Expected. Under Claude Code, settings come from the `env` block in `.mcp.json`, not
from `.env` — see the note in the server README. `.env` only applies when you run the
server by hand from its own directory.

---

## 6. Rules

- **Never commit a token.** `.env` is git-ignored; keep it that way. If a token ever
  reaches a commit, revoke it in SonarQube immediately — deleting the line is not
  enough, git history keeps it.
- **Don't add your token to `.mcp.json`.** It's shared with the whole team. It only
  ever holds `${SONARQUBE_TOKEN}` placeholders.
- **Review every diff before approving.** Claude is good at Sonar fixes and still
  occasionally wrong about intent. You own the commit.

---

## Where to go next

The full reference — every configuration variable, all tools and resources, the
safety model, and how to run the server standalone for debugging — is in
[`sonarqube-mcp-project_1/mcp/sonarqube-mcp/README.md`](sonarqube-mcp-project_1/mcp/sonarqube-mcp/README.md).
