// Talking to the viewer from another process (the MCP server): is it up,
// start it if not, and tell it a flow was drawn so open pages show it.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PORT = Number(process.env.CODE_FLOW_PORT ?? 4319)
export const BASE = `http://127.0.0.1:${PORT}`
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'code-flow.js')

export function flowUrl(root, flowId) {
  const hash = new URLSearchParams({ project: root, ...(flowId ? { flow: flowId } : {}) })
  return `${BASE}/#${hash}`
}

async function ping() {
  try {
    const res = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(600) })
    return res.ok && (await res.json()).app === 'code-flow'
  } catch {
    return false
  }
}

// Starts `code-flow serve` on its own, outliving this process, unless it already runs.
export async function ensureViewer() {
  if (await ping()) {
    return true
  }
  const child = spawn(process.execPath, [BIN, 'serve'], { detached: true, stdio: 'ignore', env: process.env })
  child.unref()
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 120))
    if (await ping()) {
      return true
    }
  }
  return false
}

// Tells the viewer about a new flow. It opens a browser tab when no page is watching.
export async function announce(root, flowId) {
  // CODE_FLOW_VIEWER=off keeps flows on disk only (tests, or a machine with no browser).
  if (process.env.CODE_FLOW_VIEWER === 'off' || !(await ensureViewer())) {
    return false
  }
  try {
    const res = await fetch(`${BASE}/api/notify?${new URLSearchParams({ root })}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: flowId }),
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}
