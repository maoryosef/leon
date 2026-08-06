# Leon

A sidekick agent that watches over your Claude Code sessions running in tmux —
and (eventually) helps you drive them, with the personality of Leon Black.

## What works today

- **Chat with Leon** (Phase 2a): a chat panel on the board, backed by the
  Claude Agent SDK. Leon has read-only tools (sessions, tasks, terminal
  peeks, transcripts, PR states) and answers in a configurable voice —
  Leon Black by default (`personalities/`, swappable via
  `[personality].promptFile` in `~/.leon/config.toml`). The conversation
  persists and resumes across daemon restarts. Mutating actions
  (typing into sessions, spawning) come next, behind an approval flow.
- **PR monitoring**: every open PR you authored (plus live session
  branches) polled via `gh`, shown in the board's PR rail with checks and
  review state.
- **Proactive notifications**: when a session finishes its turn, waits on
  a permission prompt / your input, or dies mid-work, you get a macOS
  notification AND Leon comments in chat (batched, rate-limited, silent on
  flapping). Toggle via `[notifications] desktop / chat` in
  `~/.leon/config.toml`.

- **Discovery**: finds every `claude` process in every tmux pane, no setup.
- **Status**: each session is `working / waiting_input / waiting_permission /
  idle_done / dead`, derived from three signal tiers (Claude Code hooks →
  transcript tailing → pane scraping). Low-confidence statuses are marked.
- **Task board (web)**: group sessions into tasks (a task spans repos & PRs);
  unassigned sessions land in the Inbox.
- **Peek & attach**: live read-only terminal for any session in the browser,
  one click to go interactive, or `leon attach <id>` for a native tmux attach.
- **PR tracking**: the PR for each session's current branch, with checks state.

## Running the project

### TL;DR — one command

```sh
pnpm install && pnpm start   # build web UI + run the daemon serving it
pnpm open:ui                 # (other terminal) open the board in your browser
```

`pnpm start` is idempotent — if a healthy daemon already holds the port it says
so and exits 0. Use `pnpm restart` to stop it and start fresh (e.g. after
pulling new code), and `pnpm stop` to just stop it.

`pnpm open:ui` opens `http://127.0.0.1:5366/?token=…` with the token from
`~/.leon/config.toml`. The browser stores it and drops it from the address bar,
so re-run it whenever the token changes.

For development, one command runs everything in watch mode (daemon via tsx
watch + web via vite with hot reload):

```sh
pnpm dev                            # then `pnpm open:ui` once, or :5173 with the token
```

### Prerequisites

- **Node.js ≥ 22** and **pnpm ≥ 9** (repo is pinned via `packageManager`)
- **tmux** on `PATH` (this is where your Claude Code sessions live)
- **gh** (GitHub CLI), authenticated — only needed for PR tracking
- macOS (verified); Linux should work but is untested

### 1. Install

```sh
pnpm install
```

Native modules (`better-sqlite3`, `node-pty`) are built automatically —
`pnpm-workspace.yaml` allowlists their build scripts, and the root
`postinstall` restores the exec bit on node-pty's `spawn-helper`
(a pnpm quirk; without it terminal peek fails with `posix_spawnp failed`).

### 2. Build the web UI (production mode)

```sh
pnpm --filter @leon/web build
```

The daemon serves `packages/web/dist/` when it exists. Skip this if you use
web dev mode (step 5) instead.

### 3. Start the daemon

```sh
pnpm start                          # web build + daemon (the single-command path)
# or
pnpm dev:daemon                     # daemon only, tsx watch mode (restarts on code changes)
# or
pnpm --filter @leon/daemon start    # plain foreground run
# or
node packages/cli/bin/leon.js daemon
```

First run creates `~/.leon/` with:

- `config.toml` — host/port (default `127.0.0.1:5366`), a generated bearer
  token (file mode 0600), poll intervals, personality + model settings
- `leon.db` — SQLite (WAL) with tasks/sessions/history

Discovery starts immediately: every tmux pane running `claude` shows up
within ~2 seconds, no instrumentation needed.

### 4. Open the board

```sh
node packages/cli/bin/leon.js ui    # opens http://127.0.0.1:5366/?token=<token>
```

The token from `~/.leon/config.toml` is required — the `ui` command passes it
for you (the app stores it in localStorage and strips it from the URL). All
API/WS/hook endpoints reject requests without it; the daemon binds loopback
only.

### 5. Web dev mode (optional, instead of step 2)

```sh
pnpm dev:web                        # vite on http://localhost:5173
```

Vite proxies `/api` and `/ws` to the daemon on :5366, so start the daemon
first. Grab the token once via `node packages/cli/bin/leon.js ui` (or open
`http://localhost:5173/?token=<token from ~/.leon/config.toml>`).

### 6. Precise statuses via Claude Code hooks (recommended)

```sh
node packages/cli/bin/leon.js install-hooks            # writes ~/.leon/bin/leon-hook + child-hooks.json only
node packages/cli/bin/leon.js install-hooks --global   # + merges into ~/.claude/settings.json (backs it up first)
```

Without hooks, statuses come from transcript tailing and pane scraping
(rendered as hollow "low confidence" badges). With `--global`, every Claude
Code session reports `SessionStart / UserPromptSubmit / PreToolUse /
Notification / Stop / SessionEnd` directly to the daemon — sessions pick the
hooks up on their next restart. The hook script always exits 0, so a stopped
daemon never blocks your sessions.

### CLI reference

```sh
node packages/cli/bin/leon.js daemon                 # run daemon in foreground
node packages/cli/bin/leon.js ui                     # open web UI with token
node packages/cli/bin/leon.js status                 # session table in the terminal ("?" = low-confidence status)
node packages/cli/bin/leon.js attach <id|name|dir>   # native tmux attach/switch-client to a session
node packages/cli/bin/leon.js install-hooks [--global]
```

`attach` matches by short id from `leon status`, tmux session name, cwd
basename, or session title — and uses `switch-client` when you're already
inside tmux (no nesting).

Tip: `pnpm link --global packages/cli` (or an alias) gives you a bare `leon`
command.

### Tests & checks

```sh
pnpm typecheck                      # all packages
pnpm --filter @leon/core test       # unit tests (parsers, status engine, heuristics)
pnpm build                          # typecheck everywhere + vite build
```

### Troubleshooting

- **Terminal peek fails / `posix_spawnp failed`** — run `pnpm install` again
  (postinstall re-chmods node-pty's `spawn-helper`).
- **401 in the browser** — relaunch via `node packages/cli/bin/leon.js ui`;
  the token in localStorage is missing/stale.
- **No sessions appear** — check `tmux list-panes -a` shows panes whose
  command is `claude`; Leon polls every 2s and keys on the process tree.
- **Port in use** — edit `port` under `[server]` in `~/.leon/config.toml`.
- **Reset everything** — stop the daemon and delete `~/.leon/leon.db`
  (sessions re-discover on next start; tasks are lost).

## Layout

| package | what |
|---|---|
| `packages/shared` | zod contracts: domain model, WS events, REST inputs, hook payloads |
| `packages/core`   | config, sqlite, tmux adapter, discovery, status engine, services |
| `packages/daemon` | fastify: REST + `/hooks` receiver + `/ws/events` + `/ws/term` (node-pty) |
| `packages/web`    | react board: tasks / inbox / session cards / xterm peek & attach |
| `packages/cli`    | `leon daemon · ui · status · attach · install-hooks` |
| `personalities/`  | swappable voice prompts for the Leon agent (Phase 2) |

State lives in `~/.leon/` (config.toml with the auth token, leon.db).

## Roadmap

Phase 2: the Leon agent itself — chat, read-only tools, approval-gated actions
(`send_to_session`, answering permission prompts). Phase 3: spawning sessions,
TUI. Phase 4: Jira sync. See the plan in `~/.claude/plans/` / project docs.
