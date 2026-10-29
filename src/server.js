// The viewer: a small HTTP server on 127.0.0.1 that serves the page, the
// flows kept for each project, code around a step's line, the import scan,
// live updates (server-sent events), and traces started from the page.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { excerpt } from './check.js'
import { addProject, deleteFlow, isKnownProject, listProjects, projectRoot, readProject } from './store.js'
import { startTrace } from './trace.js'
import { BASE, PORT, flowUrl } from './viewer.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, '..', 'web')
const SCAN = path.join(HERE, 'scan.mjs')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`))

const clients = new Set()
const traces = new Map()
const scans = new Map()
let lastOpened = 0
let traceCount = 0

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    res.write(data)
  }
}

function openBrowser(url) {
  if (process.env.CODE_FLOW_OPEN === '0' || Date.now() - lastOpened < 8000) {
    return
  }
  lastOpened = Date.now()
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function bodyOf(req) {
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (text.length > 1_000_000) {
      throw new Error('too large')
    }
  }
  return JSON.parse(text || '{}')
}

// The import scan runs in its own process, so a big project doesn't stall the server. Kept until asked again.
function scan(root, fresh) {
  const kept = scans.get(root)
  if (kept && !fresh) {
    return kept
  }
  const running = new Promise((resolve) => {
    const child = spawn(process.execPath, [SCAN, root], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (c) => (out += c))
    child.on('close', () => {
      try {
        resolve({ ...JSON.parse(out), at: Date.now() })
      } catch {
        scans.delete(root)
        resolve({ error: 'The scan failed.', files: [], edges: [], external: {} })
      }
    })
  })
  scans.set(root, running)
  return running
}

function traceView(t) {
  return { id: t.id, root: t.root, scenario: t.scenario, log: t.log, done: t.done, ok: t.ok, summary: t.summary, cost: t.cost, at: t.at }
}

async function api(req, res, url) {
  const route = `${req.method} ${url.pathname}`
  const root = url.searchParams.get('root') ?? ''

  if (route === 'GET /api/ping') {
    return send(res, 200, { app: 'code-flow', base: BASE })
  }
  if (route === 'GET /api/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write('retry: 2000\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (route === 'GET /api/projects') {
    return send(res, 200, listProjects())
  }
  if (route === 'POST /api/projects') {
    const dir = (await bodyOf(req)).path
    if (typeof dir !== 'string' || !path.isAbsolute(dir) || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      return send(res, 400, { error: 'Give the absolute path of a folder that exists.' })
    }
    const projectDir = projectRoot(dir)
    addProject(projectDir)
    broadcast({ type: 'projects' })
    return send(res, 200, { root: projectDir })
  }

  // Everything below reads a project, which must be one the store already knows.
  if (!isKnownProject(root)) {
    return send(res, 404, { error: 'Unknown project.' })
  }
  if (route === 'GET /api/flows') {
    return send(res, 200, readProject(root))
  }
  if (route === 'DELETE /api/flows') {
    deleteFlow(root, url.searchParams.get('id'))
    broadcast({ type: 'flows', root })
    return send(res, 200, { ok: true })
  }
  if (route === 'GET /api/code') {
    return send(res, 200, excerpt(root, url.searchParams.get('file') ?? '', Number(url.searchParams.get('line') ?? 1)))
  }
  if (route === 'GET /api/scan') {
    return send(res, 200, await scan(root, url.searchParams.get('fresh') === '1'))
  }
  if (route === 'POST /api/notify') {
    const { id } = await bodyOf(req)
    broadcast({ type: 'flow', root, id })
    if (clients.size === 0) {
      openBrowser(flowUrl(root, id))
    }
    return send(res, 200, { ok: true, watching: clients.size })
  }
  if (route === 'GET /api/traces') {
    return send(res, 200, [...traces.values()].filter((t) => t.root === root).map(traceView))
  }
  if (route === 'POST /api/traces') {
    const scenario = String((await bodyOf(req)).scenario ?? '').trim().slice(0, 500)
    if (scenario === '') {
      return send(res, 400, { error: 'Say which flow to trace.' })
    }
    const t = { id: `t${++traceCount}`, root, scenario, log: [], done: false, at: Date.now() }
    traces.set(t.id, t)
    t.stop = startTrace(root, scenario, (event) => {
      if (event.kind === 'done') {
        Object.assign(t, { done: true, ok: event.ok, summary: event.summary, cost: event.cost })
      } else {
        t.log.push(event)
      }
      broadcast({ type: 'trace', trace: traceView(t) })
    })
    broadcast({ type: 'trace', trace: traceView(t) })
    return send(res, 200, traceView(t))
  }
  if (route === 'DELETE /api/traces') {
    traces.get(url.searchParams.get('id') ?? '')?.stop?.()
    return send(res, 200, { ok: true })
  }
  return send(res, 404, { error: 'Not found.' })
}

function serveStatic(res, pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1)
  const file = path.join(WEB, name)
  if (!file.startsWith(`${WEB}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found')
    return
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  fs.createReadStream(file).pipe(res)
}

export function runServer() {
  const server = http.createServer(async (req, res) => {
    // Only this machine, by this address: a page elsewhere can't reach it by renaming itself (DNS rebinding).
    if (!HOSTS.has(req.headers.host ?? '')) {
      res.writeHead(403).end('Forbidden')
      return
    }
    // A write must be JSON from this page, never a form another site posts here.
    if (req.method !== 'GET' && (!(req.headers['content-type'] ?? '').includes('application/json') || (req.headers.origin && !ORIGINS.has(req.headers.origin)))) {
      res.writeHead(403).end('Forbidden')
      return
    }
    const url = new URL(req.url ?? '/', BASE)
    try {
      if (url.pathname.startsWith('/api/')) {
        await api(req, res, url)
      } else {
        serveStatic(res, url.pathname)
      }
    } catch (error) {
      if (!res.headersSent) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  })
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.log(`Code Flow is already running at ${BASE}`)
      process.exit(0)
    }
    throw error
  })
  server.listen(PORT, '127.0.0.1', () => console.log(`Code Flow is running at ${BASE}`))
  // Keeps proxies and sleeping laptops from dropping the event stream.
  setInterval(() => {
    for (const res of clients) {
      res.write(': ping\n\n')
    }
  }, 25_000).unref()
  return server
}
