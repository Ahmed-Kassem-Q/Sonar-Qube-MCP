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

## 1a. The fast path — install the plugin

If you just want to *use* this in your own projects, you do **not** need to clone
anything, install dependencies, or build. Inside any Claude Code session:

```
/plugin marketplace add Ahmed-Kassem-Q/Sonar-Qube-MCP
/plugin install sonarqube@alqemam-sonarqube
```

That gives you the SonarQube tools **and** all four skills in *every* project, not
just this one.

Claude Code then prompts you for two things:

- **SonarQube URL** — ask a teammate, or use `https://sonarcloud.io` for SonarCloud.
- **SonarQube user token** — generate it under **My Account → Security → Generate
  Tokens**, type *User Token*. The input is masked and the token goes into your OS
  keychain, not into any file in this repo.

The organization field only matters on SonarCloud; leave it blank for a self-hosted
server. Leave the repository-root field blank too — by default the file tools are
sandboxed to whichever project you launch Claude Code in, which is what you want.

That's the whole setup. If you'd rather manage credentials in a file, you can still
create `~/.config/sonarqube-mcp/.env` with `SONARQUBE_URL` and `SONARQUBE_TOKEN`
instead — it fills in anything left blank at the prompt.

Restart Claude Code and run `/mcp` — you should see `sonarqube` connected. **You're
done; the rest of this guide is for people who want to work on the server itself.**

---

## 2. Prerequisites (for contributors)

| Tool | Check | If missing |
|---|---|---|
| Node.js 20.6+ | `node --version` | `winget install OpenJS.NodeJS.LTS` (or [nodejs.org](https://nodejs.org)) |
| Claude Code | `claude --version` | Install the VS Code extension or CLI |

That's the whole list. Node ships with `npm`, and the server has only two runtime
dependencies, both installed locally into the project — nothing goes on your system
PATH and nothing conflicts with other projects.

---

## 3. Setup (once)

### 3.1 Clone

```bash
git clone https://github.com/Ahmed-Kassem-Q/Sonar-Qube-MCP.git
cd Sonar-Qube-MCP
```

Keep the directory structure as-is. The server is located by a path relative to the
repo root, so moving folders around will break it.

### 3.2 Get your own SonarQube token

1. Open your team's SonarQube server in a browser and sign in. (Ask a teammate for the
   URL — it isn't committed to this repository, which is public.)
2. Click your avatar → **My Account** → **Security**.
3. Under **Generate Tokens**, name it something like `claude-code-<yourname>`, choose
   type **User Token**, and click **Generate**.
4. **Copy it now.** SonarQube shows the value exactly once; if you lose it you have to
   revoke and generate a new one.

It looks like `squ_` followed by a long hex string.

### 3.3 Create your `.env`

Fastest route — pass your credentials straight in, and nothing needs editing:

```bash
cd mcp/sonarqube-mcp
npm run setup -- --url=https://your-sonarqube-host --token=squ_your_token_here
```

Or run it bare and fill in the two blanks it leaves you:

```bash
npm run setup
```

Everything else in the generated file has a working default — leave it alone unless
you have a reason not to. If a `.env` already exists, `setup` refuses to touch it, so
you can't lose a working token by re-running it.

`.env` is git-ignored, so your token stays on your machine and can never be committed.
**Never put your token in `.mcp.json`** — that file is shared with the whole team.

> On a shared terminal, prefer `npm run setup` without `--token`: flag values land in
> your shell history.

> If you prefer, you can instead export `SONARQUBE_URL` and `SONARQUBE_TOKEN` as real
> environment variables; those take precedence over `.env`. Useful for CI, where
> writing a file is awkward. If you go that route on Windows, `setx` only affects
> processes started *afterwards*, so fully restart VS Code.

### 3.4 Install and build

```bash
cd mcp/sonarqube-mcp
npm ci
npm run build
```

`npm ci` installs the exact versions locked in `package-lock.json`. `npm run build`
compiles the TypeScript in `src/` to `dist/`, which is what `.mcp.json` actually
launches — **skip the build and the server won't start.**

Re-run `npm run build` after pulling changes that touch `src/`.

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
Check that `mcp/sonarqube-mcp/.env` exists and has both `SONARQUBE_URL` and
`SONARQUBE_TOKEN` filled in — a copied `.env.example` still holds the placeholder
`squ_xxxx...`, which is not a real token. Then run `claude mcp get sonarqube` to see
the actual startup error.

**"No SonarQube credentials configured"**
The server started without a token. Either `.env` is missing, sits in the wrong
directory (it belongs in `mcp/sonarqube-mcp/`, next to `.env.example`), or the token
line is still the placeholder.

**Every tool returns 401 or 403**
The token is wrong, expired, revoked, or you lack permission on that project. Generate
a fresh one and update `.env`.

**`Cannot find module ... dist/server.js`**
You skipped the build, or pulled changes and didn't rebuild. Run `npm ci && npm run
build` in `mcp/sonarqube-mcp`.

**`node: command not found`**
Node isn't installed or isn't on PATH. Reinstall it and open a new terminal.

**You edited `.env` and nothing changed**
The server reads `.env` once at startup, so restart Claude Code (or `/mcp` reconnect)
to pick up an edit. Also check you don't have a stale `SONARQUBE_*` variable exported
in your shell — real environment variables take precedence over `.env`.

---

## 6. Rules

- **Never commit a token.** `.env` is git-ignored; keep it that way. If a token ever
  reaches a commit, revoke it in SonarQube immediately — deleting the line is not
  enough, git history keeps it.
- **Don't add your token — or your server's hostname — to `.mcp.json`.** It's shared
  with the whole team and the repository is public. `.mcp.json` holds only the command
  needed to launch the server; all configuration belongs in your own `.env`.
- **Review every diff before approving.** Claude is good at Sonar fixes and still
  occasionally wrong about intent. You own the commit.

---

## Where to go next

The full reference — every configuration variable, all tools and resources, the
safety model, and how to run the server standalone for debugging — is in
[`mcp/sonarqube-mcp/README.md`](mcp/sonarqube-mcp/README.md).
