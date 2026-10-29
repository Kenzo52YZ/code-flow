// Reads which source file imports which in a project, for JavaScript,
// TypeScript and Python, without running anything.
//
//   node deps.mjs <project root>
//
// Writes {"files": [path, ...], "edges": [[from, to], ...], "external":
// {"react": 12, ...}, "ms": n}: paths relative to the root, edges as indexes
// into `files`, and how many files import each package from outside it.
// Files come from `git ls-files` when the root is a repository (so ignored
// ones stay out), else from a walk that skips dependency and build folders.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const MAX_FILES = 20_000
const MAX_BYTES = 1024 * 1024
const JS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']
const PY = ['.py']
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.cache', 'target'])

const root = path.resolve(process.argv[2] ?? '.')
const started = Date.now()

function listFiles() {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    return out.toString('utf8').split('\0').filter(Boolean)
  } catch {
    const found = []
    const walk = dir => {
      let entries
      try {
        entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (found.length >= MAX_FILES) {
          return
        }
        const rel = dir === '' ? e.name : `${dir}/${e.name}`
        if (e.isDirectory()) {
          if (!SKIP.has(e.name) && !e.name.startsWith('.')) {
            walk(rel)
          }
        } else if (e.isFile()) {
          found.push(rel)
        }
      }
    }
    walk('')

    return found
  }
}

const files = listFiles()
  // Hidden folders (`.github`, `.omc`) hold tooling, not the app.
  .filter(f => [...JS, ...PY].includes(path.extname(f)) && !f.split('/').some(part => SKIP.has(part) || part.startsWith('.')))
  .slice(0, MAX_FILES)
const known = new Set(files)
const index = new Map(files.map((f, i) => [f, i]))

// JSON as tsconfig.json may be written: comments and trailing commas out,
// strings (`"**/*.ts"` holds a `/*`) left whole.
function jsonc(text) {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1
      }
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++
      }
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1, i + 200).replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, ''))) {
      // A trailing comma, which JSON refuses.
    } else {
      out += c
    }
  }

  return JSON.parse(out)
}

// `@/x` → `src/x`, from tsconfig.json or jsconfig.json `paths`.
function aliases() {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let text
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8')
    } catch {
      continue
    }
    try {
      const json = jsonc(text)
      const options = json.compilerOptions ?? {}
      const base = options.baseUrl ?? '.'
      return Object.entries(options.paths ?? {}).flatMap(([from, targets]) =>
        Array.isArray(targets) && targets.length > 0
          ? [{ prefix: from.replace(/\*$/, ''), to: path.posix.join(base, String(targets[0]).replace(/\*$/, '')) }]
          : [],
      )
    } catch {
      return []
    }
  }

  return []
}
const paths = aliases()

function resolveJs(from, spec) {
  let target
  if (spec.startsWith('.')) {
    target = path.posix.join(path.posix.dirname(from), spec)
  } else {
    const alias = paths.find(a => spec.startsWith(a.prefix))
    if (alias === undefined) {
      return undefined
    }
    target = path.posix.normalize(alias.to + spec.slice(alias.prefix.length))
  }
  // `./a.js` written for `./a.ts`, as TypeScript's ESM output asks.
  const stem = target.replace(/\.(js|jsx|mjs|cjs)$/, '')
  const tries = [target, ...JS.map(x => stem + x), ...JS.map(x => `${target}/index${x}`)]

  return tries.find(t => known.has(t))
}

// Where top-level Python packages live: the root, and `src/` when used.
const pyRoots = ['', 'src', 'lib'].filter(r => r === '' || fs.existsSync(path.join(root, r)))

function resolvePy(from, mod, level) {
  let parts
  if (level > 0) {
    const base = path.posix.dirname(from).split('/').filter(Boolean)
    const up = base.slice(0, Math.max(0, base.length - (level - 1)))
    parts = [...up, ...mod.split('.').filter(Boolean)]
    const rel = parts.join('/')
    return [`${rel}.py`, `${rel}/__init__.py`].find(t => known.has(t))
  }
  parts = mod.split('.')
  for (const r of pyRoots) {
    const rel = [r, ...parts].filter(Boolean).join('/')
    const hit = [`${rel}.py`, `${rel}/__init__.py`].find(t => known.has(t))
    if (hit) {
      return hit
    }
  }

  return undefined
}

const edges = new Set()
const external = Object.create(null)

function link(from, to) {
  if (to !== undefined && to !== from) {
    edges.add(`${index.get(from)},${index.get(to)}`)
  }
}

function outside(name) {
  external[name] = (external[name] ?? 0) + 1
}

function readJs(file, text) {
  const seen = new Set()
  const isCommented = at => {
    const start = text.lastIndexOf('\n', at) + 1
    const before = text.slice(start, at)

    return before.includes('//') || /^\s*(\*|\/\*)/.test(before)
  }
  const specs = [
    ...text.matchAll(/\b(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g),
    ...text.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]
    .filter(m => !isCommented(m.index ?? 0))
    .map(m => m[1])
  for (const spec of specs) {
    if (seen.has(spec)) {
      continue
    }
    seen.add(spec)
    const hit = resolveJs(file, spec)
    if (hit !== undefined) {
      link(file, hit)
    } else if (!spec.startsWith('.')) {
      outside(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0])
    }
  }
}

// An import statement whole: `from x import (` and the lines up to its
// `)`, or lines joined by a trailing backslash, each without its comment.
function statements(text) {
  const lines = text.split('\n')
  const out = []
  const depthOf = l => (l.match(/\(/g)?.length ?? 0) - (l.match(/\)/g)?.length ?? 0)
  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] ?? '').replace(/#.*$/, '')
    if (/^\s*(from|import)\s/.test(line)) {
      let depth = depthOf(line)
      while ((depth > 0 || /\\\s*$/.test(line)) && i + 1 < lines.length) {
        i++
        const more = (lines[i] ?? '').replace(/#.*$/, '')
        line = `${line.replace(/\\\s*$/, '')} ${more}`
        depth += depthOf(more)
      }
    }
    out.push(line)
  }

  return out
}

function readPy(file, text) {
  const seen = new Set()
  for (const line of statements(text)) {
    let m = /^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(line)
    if (m) {
      const level = m[1].length
      const mod = m[2]
      // `from pkg import sub` may name a module; a name that is not one
      // (a function, a class) comes from the package itself.
      const names = m[3].replace(/[()\\]/g, '').split(',').map(n => n.trim().split(/\s+/)[0]).filter(Boolean)
      let found = names.length > 0
      for (const name of names) {
        const hit = resolvePy(file, mod === '' ? name : `${mod}.${name}`, level)
        if (hit === undefined) {
          found = false
        } else if (!seen.has(hit)) {
          seen.add(hit)
          link(file, hit)
        }
      }
      if (!found) {
        const hit = resolvePy(file, mod, level)
        if (hit !== undefined) {
          if (!seen.has(hit)) {
            seen.add(hit)
            link(file, hit)
          }
        } else if (level === 0 && mod !== '' && mod !== '__future__') {
          outside(mod.split('.')[0])
        }
      }
      continue
    }
    m = /^\s*import\s+(.+)$/.exec(line)
    if (m) {
      for (const part of m[1].split(',')) {
        const mod = part.trim().split(/\s+/)[0]
        if (!mod || !/^[\w.]+$/.test(mod)) {
          continue
        }
        const hit = resolvePy(file, mod, 0)
        if (hit !== undefined) {
          if (!seen.has(hit)) {
            seen.add(hit)
            link(file, hit)
          }
        } else {
          outside(mod.split('.')[0])
        }
      }
    }
  }
}

for (const file of files) {
  let text
  try {
    const stat = fs.statSync(path.join(root, file))
    if (stat.size > MAX_BYTES) {
      continue
    }
    text = fs.readFileSync(path.join(root, file), 'utf8')
  } catch {
    continue
  }
  if (PY.includes(path.extname(file))) {
    readPy(file, text)
  } else {
    readJs(file, text)
  }
}

process.stdout.write(
  JSON.stringify({
    files,
    edges: [...edges].map(e => e.split(',').map(Number)),
    external,
    ms: Date.now() - started,
  }),
)
