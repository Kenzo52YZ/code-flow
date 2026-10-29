// A trace started from the viewer: Claude Code runs headless (`claude -p`) in
// the project, on the person's own Claude login, with read-only tools and this
// app's MCP server, so the flow it draws lands in the viewer like any other.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PORT } from './viewer.js'

export const SERVER_NAME = 'code-flow-app'
const TOOL = `mcp__${SERVER_NAME}__show_code_flow`
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'code-flow.js')
const READ_ONLY = ['Read', 'Grep', 'Glob']

export function tracePrompt(scenario) {
  return (
    `Trace the code flow in this project for: ${scenario}\n\n` +
    'Follow it through the code from what the user does to what they get back, reading the files as you go ' +
    'so each step names the real file and line. Then draw it with the show_code_flow tool. If its result lists ' +
    'steps to fix, fix them and draw again with the same title. End with a summary of the flow in two or three sentences.'
  )
}

// What a tool call is doing, in words, for the viewer's progress list.
function describe(name, input, root) {
  const rel = (p) => (typeof p === 'string' && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p)
  switch (name) {
    case 'Read':
      return `Reading ${rel(input.file_path)}`
    case 'Grep':
      return `Searching for "${input.pattern}"${input.path ? ` in ${rel(input.path)}` : ''}`
    case 'Glob':
      return `Listing ${input.pattern}`
    case TOOL:
      return `Drawing "${input.title ?? 'the flow'}"`
    default:
      return `Using ${name}`
  }
}

/**
 * Starts a trace. `onEvent` gets {kind: 'step', text}, {kind: 'text', text} and, once,
 * {kind: 'done', ok, summary, cost}. Returns a stop function.
 */
export function startTrace(root, scenario, onEvent) {
  const mcpConfig = {
    mcpServers: {
      [SERVER_NAME]: { command: process.execPath, args: [BIN, 'mcp'], env: { CODE_FLOW_ROOT: root, CODE_FLOW_PORT: String(PORT) } },
    },
  }
  const args = [
    '-p',
    tracePrompt(scenario),
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify(mcpConfig),
    '--tools',
    READ_ONLY.join(','),
    '--allowedTools',
    [...READ_ONLY, TOOL].join(','),
  ]
  const child = spawn(process.env.CODE_FLOW_CLAUDE ?? 'claude', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let finished = false
  let stderr = ''
  let buffer = ''
  const finish = (event) => {
    if (!finished) {
      finished = true
      onEvent({ kind: 'done', ...event })
    }
  }

  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at).trim()
      buffer = buffer.slice(at + 1)
      if (line === '') {
        continue
      }
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.type === 'assistant') {
        for (const part of msg.message?.content ?? []) {
          if (part.type === 'tool_use') {
            onEvent({ kind: 'step', text: describe(part.name, part.input ?? {}, root) })
          } else if (part.type === 'text' && part.text.trim() !== '') {
            onEvent({ kind: 'text', text: part.text.trim() })
          }
        }
      } else if (msg.type === 'result') {
        finish({ ok: msg.subtype === 'success' && !msg.is_error, summary: msg.result ?? msg.subtype, cost: msg.total_cost_usd })
      }
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000)
  })
  child.on('error', (error) => {
    finish({ ok: false, summary: error.code === 'ENOENT' ? 'Claude Code (`claude`) was not found on PATH.' : error.message })
  })
  child.on('close', (code) => {
    finish({ ok: code === 0, summary: stderr.trim() || `claude exited with code ${code}` })
  })

  return () => {
    if (!finished) {
      child.kill('SIGTERM')
      finish({ ok: false, summary: 'Stopped.' })
    }
  }
}
