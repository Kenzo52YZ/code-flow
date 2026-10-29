// Checks a flow against the project on disk: does each step's file exist,
// and is its line inside the file. Marks the steps and returns what is wrong.
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './flow.js'

export function checkFlow(root, flow) {
  const missing = []
  const pastEnd = []
  const lengths = new Map()
  for (const step of flow.steps) {
    // A path given whole, under the root, is made relative.
    if (step.file.startsWith(`${root}/`)) {
      step.file = step.file.slice(root.length + 1)
    }
    if (!isInside(step.file)) {
      step.isMissing = true
      missing.push(step)
      continue
    }
    if (!lengths.has(step.file)) {
      lengths.set(step.file, lineCount(path.join(root, step.file)))
    }
    const lines = lengths.get(step.file)
    if (lines === undefined) {
      step.isMissing = true
      missing.push(step)
    } else if (step.line !== undefined && step.line > lines) {
      step.isPastEnd = true
      pastEnd.push({ step, lines })
    }
  }
  return { missing, pastEnd }
}

function lineCount(file) {
  try {
    if (!fs.statSync(file).isFile()) {
      return undefined
    }
    const text = fs.readFileSync(file, 'utf8')
    return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
  } catch {
    return undefined
  }
}

// The lines around `line`, for the viewer's step list.
export function excerpt(root, file, line, before = 6, after = 18) {
  if (!isInside(file)) {
    return { error: 'The file is outside the project.' }
  }
  const full = path.join(root, file)
  let real
  try {
    real = fs.realpathSync(full)
  } catch {
    return { error: 'The file is not in the project.' }
  }
  // A symlink inside the project may still point out of it.
  if (!real.startsWith(`${fs.realpathSync(root)}${path.sep}`)) {
    return { error: 'The file is outside the project.' }
  }
  const lines = fs.readFileSync(real, 'utf8').split('\n')
  const at = Math.min(Math.max(1, line || 1), lines.length)
  const start = Math.max(1, at - before)
  return { start, line: at, lines: lines.slice(start - 1, at + after), total: lines.length }
}
