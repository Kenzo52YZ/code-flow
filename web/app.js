import { COLORS, filesSvg, flowSvg, lanesOf, shortName } from './svg.js'

// What the page shows, mirrored in the address's hash so a link opens the same view.
const state = {
  projects: [],
  root: '',
  tab: 'flows',
  flows: [],
  flowId: '',
  stepId: '',
  open: new Set(),
  traces: new Map(),
  scan: null,
  file: '',
  query: '',
  adding: false,
}

const main = document.getElementById('main')
const picker = document.getElementById('project')
const live = document.getElementById('live')

// A small element builder: strings become text, never HTML.
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false || value === null) {
      continue
    }
    if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value)
    } else if (key === 'class') {
      el.className = value
    } else {
      el.setAttribute(key, value === true ? '' : value)
    }
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) {
      el.append(child instanceof Node ? child : String(child))
    }
  }
  return el
}

async function getJson(url, options) {
  const res = await fetch(url, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(body.error ?? res.statusText)
  }
  return body
}

const q = (params) => new URLSearchParams({ root: state.root, ...params })

function ago(at) {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return new Date(at).toLocaleDateString()
}

// --- the address ----------------------------------------------------------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1))
  state.root = p.get('project') ?? state.root
  state.flowId = p.get('flow') ?? ''
  state.tab = p.get('tab') === 'files' ? 'files' : 'flows'
  state.file = p.get('file') ?? ''
}

function writeHash() {
  const p = new URLSearchParams()
  if (state.root) p.set('project', state.root)
  if (state.tab === 'files') {
    p.set('tab', 'files')
    if (state.file) p.set('file', state.file)
  } else if (state.flowId) {
    p.set('flow', state.flowId)
  }
  history.replaceState(null, '', `#${p}`)
}

// --- loading ----------------------------------------------------------------

async function loadProjects() {
  state.projects = await getJson('/api/projects')
  if (!state.projects.some((p) => p.root === state.root)) {
    state.root = state.projects[0]?.root ?? ''
  }
}

async function loadProject() {
  state.flows = []
  state.scan = null
  state.traces = new Map()
  if (!state.root) return
  const [project, traces] = await Promise.all([getJson(`/api/flows?${q()}`), getJson(`/api/traces?${q()}`)])
  state.flows = project.flows
  for (const t of traces) state.traces.set(t.id, t)
  if (!state.flows.some((f) => f.id === state.flowId)) {
    state.flowId = state.flows[0]?.id ?? ''
    state.stepId = ''
  }
}

async function loadScan(fresh = false) {
  state.scan = { loading: true }
  render()
  state.scan = await getJson(`/api/scan?${q(fresh ? { fresh: '1' } : {})}`)
  render()
}

// --- the header ---------------------------------------------------------------

function renderHeader() {
  picker.replaceChildren(
    ...state.projects.map((p) => h('option', { value: p.root, selected: p.root === state.root }, `${p.name} — ${p.root}`)),
    h('option', { value: '__add' }, 'Open another folder…'),
  )
  for (const tab of document.querySelectorAll('.tabs button')) {
    tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab))
  }
}

picker.addEventListener('change', async () => {
  if (picker.value === '__add') {
    state.adding = true
    render()
    return
  }
  state.root = picker.value
  state.flowId = ''
  state.file = ''
  state.adding = false
  await loadProject()
  render()
})

for (const tab of document.querySelectorAll('.tabs button')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab
    render()
  })
}

// --- opening a folder -----------------------------------------------------------

function addForm() {
  const input = h('input', { type: 'text', placeholder: '/home/you/Projects/app', 'aria-label': 'Folder path', class: 'mono' })
  const problem = h('p', { class: 'bad-note small' })
  const form = h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault()
        try {
          const { root } = await getJson('/api/projects', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: input.value.trim() }),
          })
          state.root = root
          state.adding = false
          state.file = ''
          state.flowId = ''
          await loadProjects()
          await loadProject()
          render()
        } catch (error) {
          problem.textContent = error.message
        }
      },
    },
    h('label', { class: 'small muted' }, 'A project folder, by its full path:', input),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Open'), state.projects.length > 0 ? h('button', { class: 'btn', type: 'button', onclick: () => ((state.adding = false), render()) }, 'Cancel') : null),
    problem,
  )
  setTimeout(() => input.focus())
  return form
}

function renderWelcome() {
  return h(
    'div',
    { class: 'empty' },
    h('h1', {}, 'No flows yet'),
    h('p', {}, 'Ask Claude Code to trace a feature, and the flow shows up here as soon as it is drawn. For example:'),
    h('p', {}, h('code', {}, 'Trace how a user signs in and draw it with show_code_flow')),
    h('p', { class: 'muted' }, 'Or open a project folder to trace from this page and explore its imports.'),
    addForm(),
  )
}

// --- flows ----------------------------------------------------------------------

function traceForm() {
  const box = h('textarea', { placeholder: 'e.g. a student submits a quiz', 'aria-label': 'Flow to trace', maxlength: '500' })
  const problem = h('p', { class: 'bad-note small' })
  return h(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault()
        const scenario = box.value.trim()
        if (!scenario) return
        try {
          const t = await getJson(`/api/traces?${q()}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) })
          state.traces.set(t.id, t)
          box.value = ''
          render()
        } catch (error) {
          problem.textContent = error.message
        }
      },
    },
    box,
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Trace with Claude')),
    h('p', { class: 'muted small' }, 'Runs Claude Code in this project on your own Claude login, with read-only tools.'),
    problem,
  )
}

function traceCard(t) {
  const state_ = t.done ? (t.ok ? h('span', { class: 'state good' }, 'Done') : h('span', { class: 'state bad' }, 'Failed')) : h('span', { class: 'state' }, 'Tracing…')
  const steps = t.log.filter((e) => e.kind === 'step').slice(-6)
  return h(
    'div',
    { class: 'trace' },
    h('div', { class: 'row', style: 'margin:0' }, h('span', { class: 'scenario' }, t.scenario), h('span', { style: 'margin-left:auto' }, state_)),
    !t.done && steps.length > 0 ? h('ol', { start: String(t.log.filter((e) => e.kind === 'step').length - steps.length + 1) }, steps.map((e) => h('li', {}, e.text))) : null,
    !t.done
      ? h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => fetch(`/api/traces?${q({ id: t.id })}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } }) }, 'Stop'))
      : h(
          'details',
          { open: !t.ok },
          h('summary', {}, `${t.ok ? 'Summary' : 'What went wrong'}${t.cost ? ` · ≈ $${t.cost.toFixed(2)} at API prices` : ''}`),
          h('p', { class: 'summary' }, t.summary ?? ''),
          h('button', { class: 'link small', type: 'button', onclick: () => (state.traces.delete(t.id), render()) }, 'Clear'),
        ),
  )
}

function renderFlowsSide() {
  const flows = state.flows.map((f) =>
    h(
      'li',
      {},
      h(
        'button',
        { class: 'item', type: 'button', 'aria-current': String(f.id === state.flowId), onclick: () => selectFlow(f.id) },
        h('span', { class: 'name' }, f.title),
        h('span', { class: 'meta' }, `${f.steps.length} steps · ${ago(f.at)}`),
      ),
      h(
        'button',
        {
          class: 'remove',
          type: 'button',
          title: 'Delete this flow',
          'aria-label': `Delete ${f.title}`,
          onclick: async () => {
            if (!confirm(`Delete "${f.title}"?`)) return
            await getJson(`/api/flows?${q({ id: f.id })}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })
          },
        },
        '×',
      ),
    ),
  )
  return h(
    'aside',
    { class: 'side' },
    h('section', {}, h('h2', {}, 'Trace a flow'), traceForm(), [...state.traces.values()].reverse().map(traceCard)),
    h('section', {}, h('h2', {}, `Flows (${state.flows.length})`), flows.length > 0 ? h('ul', { class: 'list' }, flows) : h('p', { class: 'muted small' }, 'None yet for this project.')),
  )
}

function selectFlow(id) {
  state.flowId = id
  state.stepId = ''
  state.open = new Set()
  render()
  window.scrollTo({ top: 0 })
}

function selectStep(id) {
  state.stepId = id
  state.open.add(id)
  render()
  document.getElementById(`step-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function chip(layer, lanes) {
  const color = COLORS[lanes.indexOf(layer) % COLORS.length]
  return h('span', { class: 'chip', style: `color:${color};background:${color}22` }, layer)
}

function codeBlock(file, line) {
  const pre = h('pre', { class: 'code' }, h('span', { 'data-n': '' }, 'Loading…'))
  getJson(`/api/code?${q({ file, line: String(line ?? 1) })}`)
    .then((code) => {
      if (code.error) {
        pre.replaceChildren(h('span', { 'data-n': '' }, code.error))
        return
      }
      pre.replaceChildren(...code.lines.map((text, i) => h('span', { 'data-n': String(code.start + i), class: code.start + i === line ? 'hit' : '' }, text || ' ')))
      pre.querySelector('.hit')?.scrollIntoView({ block: 'nearest' })
    })
    .catch((error) => pre.replaceChildren(h('span', { 'data-n': '' }, error.message)))
  return pre
}

function renderStep(flow, step, i, lanes) {
  const number = new Map(flow.steps.map((s, k) => [s.id, k + 1]))
  const isOpen = state.open.has(step.id)
  const isBad = step.isMissing || step.isPastEnd
  const next =
    step.next.length === 0
      ? 'the flow ends here'
      : step.next.map((e, k) => [k > 0 ? ', ' : '', h('button', { class: 'link', type: 'button', onclick: () => selectStep(e.id) }, `${number.get(e.id)}`), e.when ? ` (${e.when})` : ''])
  return h(
    'li',
    { id: `step-${step.id}`, class: `step${step.id === state.stepId ? ' on' : ''}${isBad ? ' bad' : ''}` },
    h('div', { class: 'step-head' }, h('span', { class: 'num' }, `${i + 1}.`), h('span', { class: 'title' }, step.title), chip(step.layer, lanes)),
    h('div', { class: 'where mono' }, `${step.file}${step.line ? `:${step.line}` : ''}${step.symbol ? `  ·  ${step.symbol}` : ''}`),
    step.isMissing ? h('p', { class: 'bad-note' }, 'This file is not in the project: the trace got its path wrong.') : null,
    step.isPastEnd ? h('p', { class: 'bad-note' }, 'This line is past the end of the file.') : null,
    h('p', {}, step.detail),
    step.why ? h('p', {}, h('span', { class: 'label' }, 'Why: '), step.why) : null,
    h('p', { class: 'small' }, h('span', { class: 'label' }, 'Next: '), next),
    step.isMissing
      ? null
      : h(
          'button',
          {
            class: 'link small',
            type: 'button',
            onclick: () => {
              state.open.has(step.id) ? state.open.delete(step.id) : state.open.add(step.id)
              render()
            },
          },
          isOpen ? 'Hide code' : 'Show code',
        ),
    isOpen && !step.isMissing ? codeBlock(step.file, step.line) : null,
  )
}

function renderFlow() {
  const flow = state.flows.find((f) => f.id === state.flowId)
  if (!flow) {
    return h('div', { class: 'content' }, h('div', { class: 'empty' }, h('h1', {}, 'Nothing drawn here yet'), h('p', {}, 'Trace a flow from the left, or ask Claude Code to trace one with show_code_flow in this project.')))
  }
  const lanes = lanesOf(flow)
  const bad = flow.steps.filter((s) => s.isMissing || s.isPastEnd).length
  const diagram = h('div', { class: 'diagram' })
  diagram.innerHTML = flowSvg(flow, state.stepId)
  diagram.addEventListener('click', (event) => {
    const box = event.target.closest('[data-step]')
    if (box) selectStep(box.dataset.step)
  })
  diagram.addEventListener('keydown', (event) => {
    const box = event.target.closest('[data-step]')
    if (box && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      selectStep(box.dataset.step)
    }
  })
  return h(
    'div',
    { class: 'content' },
    h('h1', {}, flow.title),
    h('p', { class: 'facts' }, h('b', {}, 'When: '), flow.trigger),
    flow.result ? h('p', { class: 'facts' }, h('b', {}, 'Result: '), flow.result) : null,
    h('p', { class: 'facts small' }, `${flow.steps.length} steps · ${lanes.length} layers · drawn ${ago(flow.at)}`),
    bad > 0 ? h('p', { class: 'warn' }, `${bad} ${bad === 1 ? 'step points' : 'steps point'} at code that isn't there. They are outlined in red.`) : null,
    diagram,
    h('ol', { class: 'steps' }, flow.steps.map((s, i) => renderStep(flow, s, i, lanes))),
  )
}

// --- files ------------------------------------------------------------------------

function neighbours(scan, file) {
  const i = scan.files.indexOf(file)
  if (i < 0) return { imports: [], importers: [] }
  const imports = scan.edges.filter(([a]) => a === i).map(([, b]) => scan.files[b])
  const importers = scan.edges.filter(([, b]) => b === i).map(([a]) => scan.files[a])
  return { imports: imports.filter(Boolean).sort(), importers: importers.filter(Boolean).sort() }
}

function ranked(scan, count) {
  const used = new Map()
  const uses = new Map()
  for (const [a, b] of scan.edges) {
    used.set(b, (used.get(b) ?? 0) + 1)
    uses.set(a, (uses.get(a) ?? 0) + 1)
  }
  const top = (m) =>
    [...m.entries()]
      .sort((x, y) => y[1] - x[1] || scan.files[x[0]].localeCompare(scan.files[y[0]]))
      .slice(0, count)
      .map(([i, n]) => ({ file: scan.files[i], count: n }))
  return { mostUsed: top(used), mostImports: top(uses) }
}

function search(scan, query, count) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  return scan.files
    .filter((f) => words.every((w) => f.toLowerCase().includes(w)))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, count)
}

function fileList(items) {
  return h(
    'ul',
    { class: 'list' },
    items.map(({ file, count }) =>
      h(
        'li',
        {},
        h('button', { class: 'item', type: 'button', 'aria-current': String(file === state.file), onclick: () => selectFile(file) }, h('span', { class: 'name mono' }, shortName(file)), h('span', { class: 'meta mono' }, file)),
        count === undefined ? null : h('span', { class: 'count' }, String(count)),
      ),
    ),
  )
}

function selectFile(file) {
  state.file = file
  render()
  window.scrollTo({ top: 0 })
}

function renderFiles() {
  const scan = state.scan
  if (!scan || scan.loading) {
    if (!scan) loadScan()
    return h('div', { class: 'layout' }, h('aside', { class: 'side' }, h('p', { class: 'muted' }, 'Reading the imports…')), h('div', { class: 'content' }))
  }
  if (scan.error) {
    return h('div', { class: 'content' }, h('p', { class: 'warn' }, scan.error), h('button', { class: 'btn', type: 'button', onclick: () => loadScan(true) }, 'Try again'))
  }
  const input = h('input', {
    type: 'search',
    placeholder: 'Find a file by its path',
    'aria-label': 'Find a file',
    value: state.query,
    oninput: (event) => {
      state.query = event.target.value
      results.replaceChildren(state.query ? fileList(search(scan, state.query, 30).map((file) => ({ file }))) : '')
    },
  })
  const results = h('div', {}, state.query ? fileList(search(scan, state.query, 30).map((file) => ({ file }))) : '')
  const { mostUsed, mostImports } = ranked(scan, 12)
  const packages = Object.entries(scan.external)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
  const side = h(
    'aside',
    { class: 'side' },
    h('section', {}, h('h2', {}, 'Find'), input, results),
    h('section', {}, h('h2', {}, 'Used the most'), fileList(mostUsed)),
    h('section', {}, h('h2', {}, 'Import the most'), fileList(mostImports)),
    packages.length > 0 ? h('section', {}, h('h2', {}, 'Packages'), h('ul', { class: 'list' }, packages.map(([name, n]) => h('li', { class: 'small' }, h('span', { class: 'mono', style: 'padding:3px 9px' }, name), h('span', { class: 'count' }, String(n)))))) : null,
    h('p', { class: 'muted small' }, `${scan.files.length} files · ${scan.edges.length} imports between them · read in ${scan.ms} ms `, h('button', { class: 'link small', type: 'button', onclick: () => loadScan(true) }, 'Read again')),
  )
  let content
  if (state.file && scan.files.includes(state.file)) {
    const { imports, importers } = neighbours(scan, state.file)
    const picture = h('div', { class: 'files-svg' })
    picture.innerHTML = filesSvg(state.file, importers, imports)
    picture.addEventListener('click', (event) => {
      const box = event.target.closest('.box[data-file]')
      if (box) selectFile(box.dataset.file)
    })
    content = h(
      'div',
      { class: 'content' },
      h('h1', { class: 'mono', style: 'font-size:17px;overflow-wrap:anywhere' }, state.file),
      picture,
      h('div', { class: 'cols' }, h('section', {}, h('h2', {}, `Used by (${importers.length})`), fileList(importers.map((file) => ({ file })))), h('section', {}, h('h2', {}, `Imports (${imports.length})`), fileList(imports.map((file) => ({ file }))))),
      h('section', { style: 'margin-top:16px' }, h('h2', {}, 'Code'), codeBlock(state.file, 1)),
    )
  } else {
    content = h('div', { class: 'content' }, h('div', { class: 'empty' }, h('h1', {}, 'Pick a file'), h('p', {}, 'See which files use it and which it uses. The scan reads JavaScript, TypeScript and Python imports without running anything.')))
  }
  return h('div', { class: 'layout' }, side, content)
}

// --- the page -------------------------------------------------------------------------

function render() {
  renderHeader()
  writeHash()
  if (state.adding || state.projects.length === 0) {
    main.replaceChildren(state.projects.length === 0 ? renderWelcome() : h('div', { class: 'empty' }, h('h1', {}, 'Open a project'), addForm()))
    return
  }
  main.replaceChildren(state.tab === 'files' ? renderFiles() : h('div', { class: 'layout' }, renderFlowsSide(), renderFlow()))
}

function connect() {
  const events = new EventSource('/api/events')
  events.onopen = () => {
    live.className = 'live on'
    live.textContent = 'Live'
  }
  events.onerror = () => {
    live.className = 'live'
    live.textContent = 'Reconnecting…'
  }
  events.onmessage = async (message) => {
    const event = JSON.parse(message.data)
    if (event.type === 'projects') {
      await loadProjects()
      render()
    } else if (event.type === 'flow' || event.type === 'flows') {
      if (event.type === 'flow' && event.root !== state.root) {
        // A flow drawn in another project: go there, it's what the person is waiting for.
        state.root = event.root
        await loadProjects()
      }
      if (event.root === state.root) {
        await loadProject()
        if (event.type === 'flow') {
          state.flowId = event.id
          state.stepId = ''
          state.open = new Set()
          state.tab = 'flows'
        }
        render()
      }
    } else if (event.type === 'trace' && event.trace.root === state.root) {
      state.traces.set(event.trace.id, event.trace)
      if (state.tab === 'flows' && !state.adding) {
        const side = main.querySelector('.side')
        // Only the sidebar changes, so typing and scrolling elsewhere are left alone.
        side?.replaceWith(renderFlowsSide())
      }
    }
  }
}

window.addEventListener('hashchange', async () => {
  const before = state.root
  readHash()
  if (state.root !== before) await loadProject()
  render()
})

readHash()
await loadProjects()
await loadProject()
render()
connect()
