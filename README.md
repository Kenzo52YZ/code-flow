# Code Flow

See how a feature runs through your code. Claude traces it, from what the user does to what they get back, and Code Flow draws it: a column per layer (UI, API, service, database…), a box per step, arrows for what follows, branch conditions on the arrows, and the code at every step's line.

It runs on your machine and needs no API key. The tracing is done by Claude Code, on your own Claude login.

## How it connects to Claude Code

Code Flow is two things in one package:

- **An MCP server** (`code-flow mcp`) with one tool, `show_code_flow`. Claude Code calls it after reading the code; the tool checks every step's file and line against the project, saves the flow, and tells Claude what it had to fix.
- **A viewer** (`code-flow serve`), a local page at <http://127.0.0.1:4319>. The MCP server starts it on the first drawing and opens a browser tab when no page is open. Open pages update live.

From the viewer you can also start a trace yourself: type what to trace, and it runs `claude -p` in the project with read-only tools (Read, Grep, Glob) and this tool, then shows the result.

```
Claude Code ──(MCP, stdio)──▶ code-flow mcp ──▶ ~/.code-flow ◀── code-flow serve ──▶ browser
     ▲                                                               │
     └─────────────── claude -p (Trace with Claude) ◀────────────────┘
```

## Set up

```bash
git clone <this repo> ~/Projects/code-flow
cd ~/Projects/code-flow && npm install
claude mcp add --scope user code-flow-app -- "$(which node)" ~/Projects/code-flow/bin/code-flow.js mcp
```

The full path to Node matters when it comes from nvm: the desktop app may not have nvm on its PATH, and would find an older system Node instead. Code Flow needs Node 20 or later.

Then in any project, ask Claude Code something like:

> Trace how a student submits a quiz and draw it with show_code_flow

## Commands

| Command | What it does |
| --- | --- |
| `code-flow serve` | Runs the viewer (also started for you by the MCP server) |
| `code-flow mcp` | Runs the MCP server over stdio (Claude Code runs this) |
| `code-flow open [dir]` | Adds a project to the viewer and opens it in the browser |

## The Files tab

A static scan of which file imports which, for JavaScript, TypeScript (with `paths` aliases from `tsconfig.json`) and Python. Nothing is run. Pick a file to see what uses it and what it uses.

## Settings

| Variable | Default | |
| --- | --- | --- |
| `CODE_FLOW_PORT` | `4319` | The viewer's port |
| `CODE_FLOW_HOME` | `~/.code-flow` | Where flows are kept, one file per project |
| `CODE_FLOW_OPEN` | | `0` stops the viewer from opening a browser tab |
| `CODE_FLOW_VIEWER` | | `off` keeps flows on disk only and never starts the viewer |
| `CODE_FLOW_CLAUDE` | `claude` | The Claude Code command used by "Trace with Claude" |

## Safety

The viewer listens on 127.0.0.1 only, answers only to `127.0.0.1` and `localhost` as its host, and takes writes only as JSON from its own page, so another website can't read your code through it or start a trace. It serves code only from projects it knows, never outside their folder.

## Develop

```bash
npm test
```
