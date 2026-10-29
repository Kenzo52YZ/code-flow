import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-flow-test-'))
process.env.CODE_FLOW_HOME = home
const { flowFrom } = await import('../src/flow.js')
const { drawFlow } = await import('../src/mcp.js')
const { readProject } = await import('../src/store.js')
const { excerpt } = await import('../src/check.js')

// A tiny project: two files, the second three lines long.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'code-flow-project-'))
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src/a.js'), "import { b } from './b.js'\nexport const a = () => b()\n")
fs.writeFileSync(path.join(root, 'src/b.js'), 'export function b() {\n  return 1\n}\n')

const step = (id, extra = {}) => ({ id, title: `Step ${id}`, file: 'src/a.js', line: 1, detail: 'Does a thing.', ...extra })
const noViewer = { show: async () => true }

test('a step without next goes to the one after it, and the last ends the flow', () => {
  const { flow, notes } = flowFrom({ title: 'T', trigger: 'Click', steps: [step('a'), step('b')] })
  assert.deepEqual(
    flow.steps.map((s) => s.next),
    [[{ id: 'b' }], []],
  )
  assert.deepEqual(notes, [])
})

test('labels, unknown ids, self arrows and duplicate ids come back as notes', () => {
  const { flow, notes } = flowFrom({
    title: 'T',
    trigger: 'Click',
    steps: [step('a', { next: [{ id: 'b', when: 'pass' }, 'zz', 'a'] }), step('b'), step('b', { next: [] })],
  })
  assert.deepEqual(flow.steps[0].next, [{ id: 'b', when: 'pass' }])
  assert.equal(flow.steps[2].id, 'b-3')
  assert.equal(notes.length, 3)
  assert.match(notes.join(' | '), /reused the id "b"/)
  assert.match(notes.join(' | '), /points to "zz", which no step has/)
  assert.match(notes.join(' | '), /points to itself/)
})

test('text over its cap is cut, and said so', () => {
  const { flow, notes } = flowFrom({ title: 'x'.repeat(200), trigger: 'Click', steps: [step('a')] })
  assert.equal(flow.title.length, 120)
  assert.match(notes[0], /title was cut to 120/)
})

test('a missing title or step field is refused', () => {
  assert.match(flowFrom({ trigger: 'Click', steps: [step('a')] }).problem, /title and a trigger/)
  assert.match(flowFrom({ title: 'T', trigger: 'Click', steps: [{ title: 'x', file: 'a' }] }).problem, /Step 1 needs/)
})

test('drawing checks files and lines against the project and keeps the flow', async () => {
  const { text, isError } = await drawFlow(
    {
      root,
      title: 'Calling b',
      trigger: 'Run a',
      steps: [step('a'), step('b', { file: 'src/b.js', line: 2 }), step('c', { file: 'src/nope.js' }), step('d', { file: 'src/b.js', line: 9 })],
    },
    noViewer,
  )
  assert.equal(isError, undefined)
  assert.match(text, /Drawn "Calling b", 4 steps/)
  assert.match(text, /files not found under .*: c \(src\/nope\.js\)/)
  assert.match(text, /d \(src\/b\.js:9, the file has 3 lines\)/)
  const saved = readProject(root).flows
  assert.equal(saved.length, 1)
  assert.equal(saved[0].steps[2].isMissing, true)
  assert.equal(saved[0].steps[3].isPastEnd, true)
})

test('a clean drawing says every file was found, and the same title replaces the old flow', async () => {
  const { text } = await drawFlow({ root, title: 'Calling b', trigger: 'Run a', steps: [step('a'), step('b', { file: 'src/b.js', line: 2 })] }, noViewer)
  assert.match(text, /All 2 files were found/)
  assert.equal(readProject(root).flows.length, 1)
})

test('a path that climbs out of the project is never read', () => {
  assert.match(excerpt(root, '../etc/passwd', 1).error, /outside the project/)
  assert.deepEqual(excerpt(root, 'src/b.js', 2).lines.slice(0, 3), ['export function b() {', '  return 1', '}'])
})
