# Leon

<p align="center">
  <img src="packages/web/public/leon.png" alt="Leon's avatar" width="160">
</p>

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

- **Status line**: a rail along the bottom of the board with the numbers that
  decide how much runway you have.
  - *Plan usage* — how much of each rate-limit pool is gone (all-models
    weekly, model-scoped weekly, and the rolling 5-hour session pool) plus
    the countdown to the weekly reset. The daemon polls the same endpoint
    Claude Code's own status line uses (every 5 min; `[usage] enabled /
    pollMs` in `~/.leon/config.toml`), reading the OAuth token Claude Code
    already stores — no changes to your Claude settings, and it keeps working
    when no session is running.
  - *Leon's own model, context and spend* — the model actually answering
    (reported per message by the SDK, not the configured alias), how full his
    conversation's context
    window is (amber past 70%, red past 90%, since a full window means a
    compact) and what that conversation has cost, taken from the Agent SDK's
    result messages. The cost is banked in the kv store, so it survives
    daemon restarts the same way the conversation does.

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

### TL;DR — the desktop app

```sh
pnpm install && pnpm desktop   # Leon in its own window, daemon and all
```

One command, one window, the avatar in the Dock. The app starts the daemon
itself (or attaches to one already running in tmux) and opens the board. See
[Desktop app](#desktop-app) for packaging it into a real `Leon.app`.

### Or run it headless, in the browser

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

### Desktop app

Leon runs as a native window with the avatar as its icon.

```sh
pnpm desktop        # build the web UI, then open the app
pnpm desktop:dist   # package release/mac-arm64/Leon.app (double-clickable)
```

The Electron shell is thin on purpose. It:

- **attaches to a running daemon** if one already owns the port (your tmux
  daemon keeps running and outlives the app), otherwise **starts one** and
  stops it again on quit;
- **runs the daemon as a child process under your system Node**, not inside
  Electron — `better-sqlite3` and `node-pty` are compiled for the system ABI,
  so this avoids rebuilding them against Electron's;
- **asks your login shell for `PATH`** before spawning, because an app
  launched from the Dock inherits a bare one and the daemon needs `tmux`,
  `gh` and `claude`;
- opens PR/Jira links in your real browser, and remembers window bounds in
  `~/.leon/desktop-window.json`.

The renderer is the same web app the browser gets, with no Node access — it
talks to the daemon over HTTP/WS exactly as before.

**Icons** are built from `packages/web/public/leon.png` by
`scripts/make-icons.mjs`, which shapes it to Apple's macOS template so it sits
naturally next to other apps: an 824px body centred on a 1024px canvas (the
margin is what makes every dock icon look the same size), masked to the
squircle, with a soft drop shadow baked in — macOS adds none of its own. It
also crops in on the face, since the avatar is framed for a 22px header chip
and reads too small in a dock tile; tune `FOCUS` / `ZOOM` at the top of the
script. Swap `leon.png` and run `pnpm --filter @leon/desktop icons` to
regenerate `build/icon.png` and `build/icon.icns`.

The script runs under Electron, not node — `nativeImage` is the only image
codec in the toolchain, and masking needs raw pixels.

**Why `pnpm desktop` copies the Electron bundle.** Running `electron
dist/main.js` launches Electron's *own* `Electron.app`, and macOS labels an
app in the Dock and ⌘-Tab by its bundle **directory name** — so it shows
"Electron" no matter what `CFBundleName` says, and `app.setName()` can't
reach it either (that only renames Electron-level things like the userData
dir). `scripts/dev-app.mjs` therefore keeps a branded copy at
`.devapp/Leon.app` — patched name, its own bundle id, the app icon — and
launches that. The copy is ~270MB, made once and refreshed only when Electron
or the icon changes; delete `.devapp/` to force a rebuild.

The executable inside keeps its original name so the bundle's code signature
stays valid, which means `ps` and Activity Monitor still say Electron. Only
the packaged app gets a binary named `Leon` as well.

**The packaged app still needs the repo** — it runs the daemon from your
checkout. `pnpm desktop:dist` bakes the current path into the bundle; override
with `LEON_REPO=/path/to/leon`, and `LEON_NODE=/path/to/node` if Node can't be
found. Both failures show a dialog saying exactly that. The bundle is
unsigned (`identity: null`) — it's a local tool.

### Native avatar (Superset alerts)

```sh
pnpm avatar   # build native/build/Leon.app (Swift, no Node) and open it
```

Leon sits in the bottom-right corner, above all windows and on every Space.
A bubble pops up when a Superset agent finishes a turn, fails, or waits on
you. The bubble shows the workspace and the agent's last words. Click a
bubble to open its workspace in Superset. The ring turns orange and pulses
while an agent waits on you.

- Click Leon for a summary. Hover and press **–** to minimize him.
- Right-click Leon to restore, clear alerts, or quit. He has no Dock icon.
- Right-click **Keep Mac awake** to stop idle sleep, like `caffeinate -i`.
  A coffee cup on Leon shows it is on. Click the cup to turn it off. It turns
  off when Leon quits.
- Right-click **Stay awake with lid closed** to turn off all sleep, lid close
  included (`pmset -a disablesleep 1`). It needs your admin password, and a
  glowing purple dashed ring and a red laptop badge show it is on. Click the
  badge to turn it off. The setting outlives Leon, so quitting Leon
  from its menu turns it off again. A sudoers rule for `/usr/bin/pmset` skips
  the password prompt.
- It needs no daemon. It reads Superset's host DB
  (`~/.superset/host/*/host.db`) read-only every 1.5 s, and reads previews
  from `~/.claude/projects`. That DB is internal to Superset, so a Superset
  update can break it.

#### Clean up workspaces

Right-click Leon and choose **Clean up workspaces…**. The window lists every
Superset worktree, grouped by project and by sidebar folder. Tick single
worktrees, a whole folder, or a whole project. Badges show open terminals,
agent state, and uncommitted files.

**Exit & delete** asks for confirmation and names the worktrees with
uncommitted changes. Then Leon:

1. Sends `/exit` to each agent and waits up to 15 s for it to end.
2. Sends `exit` to each terminal, up to 3 times, because a shell may start
   tmux first. It closes any terminal that is still open.
3. Runs `superset workspaces delete --local`. This removes the worktree and
   forces past uncommitted changes. The branch is kept.

Project checkouts (the `local` workspaces) are never listed.

#### Raycast

A Raycast extension in `raycast/` shows Leon's tasks and runs his actions.

**Install the extension:**

1. Install [Raycast](https://www.raycast.com) and Node.js 22 or newer.
2. Build and start the avatar app with `pnpm avatar`. The extension talks to
   it and does nothing without it.
3. From the repo root, run `pnpm raycast`. It installs the dependencies,
   builds the extension, and imports it into Raycast.
4. Wait for `ready - built extension successfully`, then press Ctrl-C. The
   extension stays in Raycast.
5. Open Raycast and search for "Leon". To add hotkeys, open Raycast settings,
   go to Extensions, and select Leon.

| Command | What it does |
|---|---|
| Leon Tasks | Agents that need you, failed, finished, or are working. Open one in Superset, dismiss it, or clear all. Also toggles keep-awake, lid-closed awake, and minimize. |
| Clean Up Workspaces | The same exit-and-delete flow as the avatar window. Enter selects a worktree, ⌘⇧F a whole folder, ⌘⇧P a whole project, ⌘⇧⌫ deletes. |
| Toggle Keep Mac Awake | One-key toggle. Bind a hotkey in Raycast. |
| Toggle Stay Awake With Lid Closed | One-key toggle. Asks for your password. |

If the avatar app is not running, the commands offer to launch it.

**Update the extension** after you pull changes or edit `raycast/src`:

1. Run `pnpm raycast`. It installs new dependencies, rebuilds, and imports
   the new version into Raycast.
2. Wait for `ready - built extension successfully`, then press Ctrl-C.
3. If the change also touched `native/`, run `pnpm avatar` too. The extension
   and the avatar share the API, so update both together.

While you work on the extension, leave `pnpm raycast` running. It rebuilds
and reloads the extension each time you save a file.

**How it connects:** the avatar serves a small HTTP API on
`127.0.0.1:5367`. Each launch writes a new token to `~/.leon/avatar-api.json`
(mode 0600), and every request must send it.

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
- **Desktop app says the daemon exited** — the dialog carries the daemon's
  last output; the usual causes are a stale build (`pnpm install`) or the port
  being held by something that isn't Leon.
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
| `packages/desktop`| electron shell: window, dock icon, daemon supervision |
| `personalities/`  | swappable voice prompts for the Leon agent (Phase 2) |

State lives in `~/.leon/` (config.toml with the auth token, leon.db).

## Roadmap

Phase 2: the Leon agent itself — chat, read-only tools, approval-gated actions
(`send_to_session`, answering permission prompts). Phase 3: spawning sessions,
TUI. Phase 4: Jira sync. See the plan in `~/.claude/plans/` / project docs.
