// Where flows are kept: one JSON file per project under ~/.code-flow (or
// $CODE_FLOW_HOME), so every Claude Code session and the viewer share them.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export const MAX_FLOWS = 30

export function homeDir() {
  return process.env.CODE_FLOW_HOME ?? path.join(os.homedir(), '.code-flow')
}

function projectsDir() {
  return path.join(homeDir(), 'projects')
}

function fileOf(root) {
  return path.join(projectsDir(), `${crypto.createHash('sha1').update(root).digest('hex').slice(0, 16)}.json`)
}

// The project a session works in: the git repository around `dir`, else `dir` itself.
export function projectRoot(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return path.resolve(dir)
  }
}

export function readProject(root) {
  try {
    const data = JSON.parse(fs.readFileSync(fileOf(root), 'utf8'))
    return { root, flows: Array.isArray(data.flows) ? data.flows : [] }
  } catch {
    return { root, flows: [] }
  }
}

// Every project that has flows, the one drawn in last first.
export function listProjects() {
  let names
  try {
    names = fs.readdirSync(projectsDir()).filter((n) => n.endsWith('.json'))
  } catch {
    return []
  }
  const projects = []
  for (const name of names) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(projectsDir(), name), 'utf8'))
      if (typeof data.root === 'string' && Array.isArray(data.flows)) {
        projects.push({ root: data.root, name: path.basename(data.root), flows: data.flows.length, at: data.flows[0]?.at ?? 0 })
      }
    } catch {
      // A file another process is writing; it shows next time.
    }
  }
  return projects.sort((a, b) => b.at - a.at)
}

export function isKnownProject(root) {
  return fs.existsSync(fileOf(root))
}

// Adds a flow at the top; one with the same title replaces the old one, which is how a fixed trace is redrawn.
export function saveFlow(root, flow) {
  const project = readProject(root)
  const flows = [flow, ...project.flows.filter((f) => f.title !== flow.title)].slice(0, MAX_FLOWS)
  writeProject(root, flows)
  return flows
}

export function deleteFlow(root, id) {
  const project = readProject(root)
  writeProject(
    root,
    project.flows.filter((f) => f.id !== id),
  )
}

// Opens a project with no flows yet, so the viewer can show its files.
export function addProject(root) {
  if (!isKnownProject(root)) {
    writeProject(root, [])
  }
}

function writeProject(root, flows) {
  fs.mkdirSync(projectsDir(), { recursive: true })
  const file = fileOf(root)
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ root, flows }, null, 1))
  fs.renameSync(tmp, file)
}
