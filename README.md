# Agent Terminal Manager

A VS Code extension that tracks AI agent sessions (Claude, Codex) in VS Code terminals with a sidebar panel. See at a glance which sessions are running, waiting for input, or need your attention — across all your VS Code windows.

## Requirements

- **VS Code 1.85+**
- **Claude Code CLI** and/or **Codex CLI** must be installed and available in your terminal PATH (verify with `which claude` or `which codex`)
- **Python 3** must be available as `python3` (used by the hook reporter script for JSON parsing and socket communication)
- **Git** — used to detect the current branch for sidebar labels. Branch detection fails gracefully if git is not installed, but labels will be missing.
- **`ps`** (Unix) — used to walk the process tree and match Claude sessions to their VS Code terminals. Pre-installed on macOS and Linux.
- **`code` CLI** (or `code-insiders`) — used by default, and as a fallback, to activate remote VS Code windows. Install via Command Palette → "Shell Command: Install 'code' command in PATH". On macOS, the optional Accessibility focus mode can usually avoid the CLI path.

## Installation

Install via **Extensions** panel → `...` → **Install from VSIX...**.

## Setup

The extension registers hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` on activation. No special terminal setup is required.

- Claude and Codex sessions will appear in the **Terminals** panel in the Explorer view.

## Features

### Sidebar Panel

The extension adds a **Terminals** panel to its own activity bar icon. Each row is
a session: its title, how long since it last did anything, and — when something
is pending — the line that matters, such as `Allow Bash: pnpm vitest run?`.

Rows sort so the ones waiting on you come first, and they carry a left amber rail
so you can find them without reading. Projects sort the same way: a project with
a session waiting on you outranks one that is merely running, which outranks an
idle one.

Set `claudeTerminalManager.sidebar.density` to `compact` to drop the status line
and get one line per session.

#### Active, Recent, Tickets

The panel has a tab strip at the top. Each tab groups by project:

- **Active** — sessions whose process is still running, plus any plain terminals.
- **Recent** — sessions that ended within the history window, dimmed, ordered by
  the project touched most recently. Clicking one resumes it with
  `claude --resume`.
- **Tickets** — only present when `claudeTerminalManager.tickets.command` is set
  and returns usable JSON.

A project appears under both tabs when you have live work in it *and* finished
sessions from earlier. Closing a session's terminal moves its row from
**Active** to **Recent**, where it stays resumable. In **Recent**, the project
this window has open is pinned to the top — it is the one you are most likely to
want back.

#### Sessions open in their own project's window

Resuming a session, or pressing the **+** on a project header, opens the
terminal in the VS Code window that owns that project rather than the window you
clicked from. Three cases:

1. **This window owns the folder** — the terminal opens here.
2. **Another open window owns it** — the request is handed to that window over
   the shared storage directory, and that window is activated.
3. **No window has it open** — a window is launched for the folder, and it runs
   the request as it activates.

Requests are keyed by the *workspace folder* that will claim them (a session can
run in a subdirectory of it), can only be claimed once, and expire after three
minutes so a window that never opened cannot trigger a session later.

#### Grouping by ticket instead

The **Tickets** tab groups by workflow state, then ticket, then session, rather
than by project. See [Ticket grouping](#ticket-grouping).

#### Starting a session

The **+** button in the panel title opens a terminal running `claude` in the
**editor area**, not as another sidebar view. Hovering a project header gives it
its own **+**, which starts a session in that project — in that project's window.
See [`newSession.location`](#claudeterminalmanagernewsessionlocation) for where
exactly the terminal lands.

### Session Tracking

Each CLI agent session (Claude Code, Codex) is tracked through its full lifecycle via hook events:

| Event | What it means |
|-------|---------------|
| **SessionStart** | A new agent process starts (claude or codex). The extension records the session ID, PID, working directory, and git branch. |
| **UserPromptSubmit** | You sent a prompt. The session status moves to **running** and the prompt text appears as a subtitle in the sidebar. |
| **PreToolUse** | Claude is about to use a tool (e.g. Bash, Read, Write). Running sessions show a leading activity indicator and put the current activity after the CLI name (e.g. "Codex Running: Bash — _topic_"). If the tool is `AskUserQuestion` or `ExitPlanMode`, the session is flagged as **needs attention**. |
| **PermissionRequest** | Claude is blocked on a permission prompt (Bash approval, an edit, an MCP call). The session is flagged as **needs attention** and the sidebar shows what is being asked, e.g. "Allow Bash: pnpm test?". Unlike `PreToolUse`, which fires before the permission check, this only fires when Claude is genuinely waiting on you. |
| **PostToolUse / PostToolUseFailure** | Interrupted tool executions (for example, a Bash process cancelled with Control-C) move the session back to **waiting for input** and clear the running activity indicator. Ordinary completions clear a permission prompt the user has just granted. |
| **Stop / StopFailure** | The turn ended. If the payload still lists background agents or background shell tasks, the session stays **running** with a "N background tasks running" label — reporting "waiting for input" during those lulls would ping you on every pause between background phases. Otherwise the session is flagged as **needs attention**. `StopFailure` (a turn that died on an API error) takes the same path, so a failed turn never strands the session as running. |
| **SubagentStop** | A background agent finished. The only event that refreshes the background-task count while the main loop sits at the prompt. When the last one finishes on a turn that had already ended, this is what hands the session back to you — nothing else fires. It never wakes a retired session or takes the attention dot off a finished turn, since it also fires for internal utility agents. |
| **SessionEnd** | The session ended. Retires it immediately, instead of waiting for the pid reaper's next poll (which still covers a `kill -9` that fires no hook). |

### Session Status Indicators

Each row carries one indicator, coloured from your theme's chart palette:

| Indicator | State | Set by |
|---|---|---|
| Spinning teal ring | **Working** — a tool is running | `PreToolUse` |
| Amber dot, amber rail | **Waiting on you** — a permission prompt, a question, or the end of a turn | `Stop`, `PermissionRequest`, `AskUserQuestion`, `ExitPlanMode` |
| Violet dot | **Subagents still out** — the main loop is free but background agents are running | `Stop` with `background_tasks > 0` |
| Hollow grey circle | **Parked** — idle, nothing pending | acknowledged, or a new prompt submitted |
| Dimmed hollow circle | **Ended** — click to resume | `SessionEnd`, or a session from the history index |

A waiting session stops asking for attention once you focus its terminal —
unless a permission prompt is genuinely still on screen, which the extension
knows from the blocking tool.

### Session Naming & Slugs

Sessions are labeled using the following priority:

1. **Custom name** — set via the rename command (pencil icon)
2. **Slug** — automatically resolved from Claude Code's conversation JSONL file. The extension reads `customTitle` (user-set title) first, falling back to `slug` (auto-generated identifier like "structured-fluttering-church"). Slugs are re-checked every 5 seconds to pick up renames.
3. **"Claude"** — default fallback

### Terminal Correlation

The extension automatically matches Claude sessions to their VS Code terminal by walking the process tree (child → parent) up to 20 hops. This lets you click a session in the sidebar to jump directly to the terminal running it.

### Multi-Window Support

When enabled, the sidebar shows terminals from **all open VS Code windows**, grouped by workspace:

- **Local section** — terminals in the current window (labeled with workspace name and git branch)
- **Remote sections** — terminals from other VS Code windows, each showing their workspace name and branch

Each window publishes its terminal state to a shared registry file (heartbeat every 30s, stale entries pruned after 90s). Clicking a remote terminal sends a focus request via IPC and activates the target window using the `code` CLI (`code -r <folder>`, or `code-insiders -r` for Insiders builds). On macOS, an opt-in Accessibility mode can select the matching native window through VS Code's Window menu and falls back to the CLI if the window cannot be identified uniquely.

### Focus & Navigation

| Action | What it does |
|--------|--------------|
| **Click a local session** | Shows that terminal and clears the "needs attention" flag |
| **Click a remote terminal** | Sends a focus request to the owning window, which shows the terminal. The target window is activated via the configured focus mode. |
| **Focus Window** (window icon on remote section header) | Activates the remote VS Code window via the configured focus mode |

### Session Reaper

A background process checks every 5 seconds whether tracked Claude processes are still alive. Dead processes are automatically cleaned up with a synthetic `session_end` event and immediately removed from the sidebar.

### Git Branch Detection

The current git branch is detected every 5 seconds and displayed next to the workspace name in the sidebar section headers (e.g. "my-project - feature/auth").

### Commands

| Command | Description |
|---------|-------------|
| **New Claude Session** (+ icon) | Open a terminal running `claude` in the editor area |
| **Resume Session** | Re-open a finished session with `claude --resume <id>` |
| **Refresh Tickets and History** (refresh icon) | Re-run the tickets command and re-index finished sessions |
| **Rename** (pencil icon) | Set a custom display name for a Claude session |
| **Focus Terminal** (arrow icon) | Jump to the terminal running a local Claude session |
| **Focus Remote Terminal** (arrow icon) | Focus a terminal in another VS Code window |
| **Focus Window** (window icon) | Activate a remote VS Code window |
| **Close Terminal** (trash icon) | Close a terminal or end a Claude session |
| **Reset Terminal State** (trash icon) | Clear all tracked sessions (with confirmation) |
| **Install Hooks** | Register hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` |
| **Remove Hooks** | Remove hooks from `~/.claude/settings.json` and `~/.codex/hooks.json` |
| **Check Hooks Status** | Check whether hooks are currently installed for Claude and Codex |

## How It Works

1. The extension registers hooks in `~/.claude/settings.json` and `~/.codex/hooks.json` on activation.
2. The hooks forward session lifecycle events (start, prompts, tool use, stop) to the extension via a Unix socket.
3. The extension parses events, updates a state machine, and renders the live session tree in the sidebar. Claude and Codex sessions are identified by their labels; redundant per-session CLI icons are omitted.

## Settings

### `claudeTerminalManager.sidebar.showNonClaudeTerminals`

**Default:** `false`

Controls whether plain (non-agent) terminals appear in the panel. When `false`, only agent sessions are shown. When `true`, terminals with no session are listed under their project with a terminal glyph, below the sessions.

### `claudeTerminalManager.status.verboseToolNames`

**Default:** `true`

Controls whether the currently running tool name appears after the CLI name. When enabled, the details begin with text such as "Running: Bash" or "Running: Read". When disabled, they begin with just "Running". The leading spinning activity indicator is shown in either case.

### `claudeTerminalManager.sidebar.showTerminalsFromAllWindows`

**Default:** `true`

Controls whether sessions from other VS Code windows appear in the panel. When enabled, they are grouped alongside local ones by project. When disabled, only sessions from the current window are shown.

A window running an older version of the extension still appears — it simply publishes fewer fields, so its rows show less.

### `claudeTerminalManager.windowFocus.useMacOSAccessibility`

**Default:** `false`

On macOS, activates a specific remote VS Code window through the native Accessibility interface instead of launching the `code` CLI. Enable Visual Studio Code under **System Settings → Privacy & Security → Accessibility** before turning this on. The extension requires exactly one VS Code window title to match the remote workspace name; otherwise it falls back to `code -r`.

### `claudeTerminalManager.sidebar.density`

**Default:** `comfortable`

`comfortable` shows the status line under each session — the blocking question, the running tool, or your last prompt. `compact` hides it, giving one line per session.

### `claudeTerminalManager.history.hours`

**Default:** `24`

How far back to list finished sessions under each project. Set to `0` to hide them entirely.

The index comes from `~/.claude/projects/`, so it needs no configuration and works for every user. A session that is currently running is never also listed as history.

### `claudeTerminalManager.newSession.location`

**Default:** `editorMain`

Where **New Claude Session** and **Resume** open their terminal.

| Value | Where it lands |
|---|---|
| `editorMain` | The first editor group — the main area, never a split |
| `editor` | Whichever editor group is active, which may itself be a split |
| `beside` | Split beside the active editor group |
| `panel` | The bottom terminal dock |

This is the reason the extension opens sessions itself rather than deferring to the Claude extension's tab-bar button: that button calls its command with no argument, which its code maps to a split, and no setting exposes the choice.

### `claudeTerminalManager.newSession.command`

**Default:** `claude`

The command run in a new session terminal. Resuming appends `--resume <id>`.

### `claudeTerminalManager.tickets.command`

**Default:** `""` (empty — the **Tickets** tab is hidden)

<a id="ticket-grouping"></a>
A shell command printing ticket JSON on stdout. When set, the panel offers a **Tickets** tab grouping sessions by workflow state, then ticket, then session. If the command fails or returns nothing usable, the tab disappears rather than showing an error.

Sessions are matched to live ones by their Claude session UUID, so a running session lights up inside its ticket; every other row is a past session that resumes on click.

Expected shape:

```json
[
  {
    "ticket": "sc-7465",
    "etat": "In Development",
    "titre": "expose origin TTFB in Server-Timing",
    "url": "https://app.shortcut.com/org/story/7465",
    "sessions": [
      {
        "id": "735a448d-3716-4845-8b87-012492256a17",
        "nom": "Couchbase config replication",
        "projet": "fstrz",
        "fin": 1789370908474
      }
    ]
  }
]
```

The English key names `id` / `state` / `title` / `name` / `project` / `endedAt` are accepted too, so any script emitting either shape works without a wrapper.

### `claudeTerminalManager.tickets.refreshSeconds`

**Default:** `60` (minimum `15`)

How often to re-run the tickets command while the panel is visible. The command is never run on the render path.

## Keyboard Shortcuts

The extension provides shortcuts to focus sessions by their position in the panel.

When enabled, the first ten rows carry a small number badge, and `Ctrl+Alt+<n>` focuses the row showing that number. Because the numbers are assigned in the order the panel renders — sessions waiting on you first — the badge you see is always the key that focuses it. Finished sessions are never numbered: a keystroke that spawns a terminal is not what the binding means.

### Enabling Shortcuts

Shortcuts are disabled by default. Enable them in Settings:

1. Open **Settings** (Cmd+, / Ctrl+,)
2. Search for `claudeTerminalManager.keyboard.enableTerminalShortcuts`
3. Check the box to enable

### Default Bindings

| Shortcut | Action |
|----------|--------|
| Ctrl+Alt+0 | Focus Session 0 (first row in the panel) |
| Ctrl+Alt+1 | Focus Session 1 |
| ... | ... |
| Ctrl+Alt+9 | Focus Session 9 |

Numpad equivalents (Ctrl+Alt+Numpad0–9) are also bound.

### Customizing Shortcuts

To rebind any shortcut:

1. Open the Command Palette (Cmd+Shift+P / Ctrl+Shift+P)
2. Run **Agent Terminal Manager: Customize Terminal Shortcuts**
3. This opens the Keyboard Shortcuts editor filtered to the focus commands
4. Double-click any entry to assign a new keybinding

Alternatively, open **Keyboard Shortcuts** (Cmd+K Cmd+S) and search for `Focus Session`.

## Troubleshooting

If sessions are not appearing in the sidebar:

1. Check that hooks are registered in `~/.claude/settings.json` and/or `~/.codex/hooks.json` — look for entries containing `--vscode-ctm`.
2. Run `echo $VSCODE_CLAUDE_SOCKET` in a VS Code terminal — it should print a socket path like `/tmp/vscode-claude-<uuid>.sock`. If it is empty, try relaunching the terminal or reloading VS Code.

## Accessibility

All session tree items include `accessibilityInformation` labels so screen readers can announce the session name and current status. Session status indicators (filled dot, open dot) are also conveyed through text labels, not just visual symbols.

## Development

### Building from Source

Clone the repo, then build and install the extension:

```sh
pnpm build-install
```

This compiles the extension, packages it as a `.vsix` file, and installs it into your running VS Code instance.
