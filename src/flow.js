// A traced flow as the show_code_flow tool takes it: checked, trimmed to its
// limits, and with a note for everything that was changed or dropped, so the
// model hears about it instead of the drawing quietly differing from its input.

export const LIMITS = {
  steps: 40,
  next: 6,
  title: 120,
  trigger: 300,
  result: 400,
  stepTitle: 120,
  file: 400,
  symbol: 120,
  layer: 30,
  detail: 1000,
  why: 600,
  id: 40,
  when: 60,
}

// The tool's input schema. The caps are here too, so the model can keep to them.
export const INPUT_SCHEMA = {
  type: 'object',
  required: ['title', 'trigger', 'steps'],
  properties: {
    title: { type: 'string', maxLength: LIMITS.title, description: 'A short name for the flow, e.g. "Student submits a quiz"' },
    trigger: { type: 'string', maxLength: LIMITS.trigger, description: 'What the user does that starts it' },
    result: { type: 'string', maxLength: LIMITS.result, description: 'What the user gets back at the end' },
    root: {
      type: 'string',
      description: "Absolute path of the project the files are in. Leave it out to use the repository Claude Code runs in.",
    },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: LIMITS.steps,
      items: {
        type: 'object',
        required: ['title', 'file', 'detail'],
        properties: {
          id: { type: 'string', maxLength: LIMITS.id, description: 'Short and unique within the flow, e.g. "s3"' },
          title: { type: 'string', maxLength: LIMITS.stepTitle, description: 'What happens, in a few words' },
          file: { type: 'string', maxLength: LIMITS.file, description: 'Path relative to the repository root' },
          line: {
            type: 'integer',
            minimum: 1,
            description: "For a whole function or handler, the line it starts on; for a branch or one statement, that statement's line",
          },
          symbol: { type: 'string', maxLength: LIMITS.symbol, description: 'The function, component, route or handler' },
          layer: {
            type: 'string',
            maxLength: LIMITS.layer,
            description: 'Where it runs, one word, reused across steps: UI, API, service, database, queue, external... Columns follow the order layers first appear.',
          },
          detail: { type: 'string', maxLength: LIMITS.detail, description: 'What the code does here, in a sentence or two' },
          why: { type: 'string', maxLength: LIMITS.why, description: 'Why the flow reaches this step: the call, event or condition' },
          next: {
            type: 'array',
            maxItems: LIMITS.next,
            description:
              'The steps that follow: an id, or {id, when} to label the arrow with its condition ("pass", "not signed in"). Left out means the next step in the list; [] ends the flow.',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  required: ['id'],
                  properties: { id: { type: 'string' }, when: { type: 'string', maxLength: LIMITS.when } },
                },
              ],
            },
          },
        },
      },
    },
  },
}

export const TOOL_DESCRIPTION =
  'Draws a code flow in the Code Flow app (a page in the browser): what runs, in order, when the user does something, ' +
  'from their action to what they get back. Use it when asked to trace, map or show how a feature flows through the code. ' +
  'Read the code first: every step must name a real file (relative to the repository root) and the line where that ' +
  "step's code is, with what it does and why the flow reaches it (the call, event, route or condition). Keep steps at " +
  'the level of a function or handler, one per meaningful hop, 8 to 20 for most flows. Mark branches with several ' +
  '`next` entries and label each arrow with `when`. The result says what was drawn, gives the link, and lists any ' +
  'step it had to change or could not check: fix those and call it again with the same title to replace the drawing.'

// Flattens whitespace and cuts to `max`; returns the text and whether it was cut.
function text(value, max) {
  if (typeof value !== 'string') {
    return { value: undefined, cut: false }
  }
  const flat = value.replace(/\s+/g, ' ').trim()
  if (flat === '') {
    return { value: undefined, cut: false }
  }
  return flat.length > max ? { value: `${flat.slice(0, max - 1)}…`, cut: true } : { value: flat, cut: false }
}

/**
 * The tool's input as a flow, or the problem that stops it from being one.
 * `notes` lists every change made on the way: cut text, renamed ids, dropped arrows.
 */
export function flowFrom(input, at = Date.now()) {
  const notes = []
  const field = (value, max, label) => {
    const t = text(value, max)
    if (t.cut) {
      notes.push(`${label} was cut to ${max} characters`)
    }
    return t.value
  }
  const title = field(input?.title, LIMITS.title, 'title')
  const trigger = field(input?.trigger, LIMITS.trigger, 'trigger')
  const steps = Array.isArray(input?.steps) ? input.steps : []
  if (title === undefined || trigger === undefined) {
    return { problem: 'Give the flow a title and a trigger (what the user does that starts it).' }
  }
  if (steps.length === 0 || steps.length > LIMITS.steps) {
    return { problem: `Give between 1 and ${LIMITS.steps} steps.` }
  }

  const parsed = []
  const ids = new Set()
  for (const [i, raw] of steps.entries()) {
    const s = typeof raw === 'object' && raw !== null ? raw : {}
    const n = i + 1
    const stepTitle = field(s.title, LIMITS.stepTitle, `step ${n} title`)
    const file = field(s.file, LIMITS.file, `step ${n} file`)?.replace(/^\.\//, '')
    const detail = field(s.detail, LIMITS.detail, `step ${n} detail`)
    if (stepTitle === undefined || file === undefined || detail === undefined) {
      return { problem: `Step ${n} needs a title, a file and a detail.` }
    }
    let id = field(s.id, LIMITS.id, `step ${n} id`) ?? `s${n}`
    if (ids.has(id)) {
      const renamed = `${id}-${n}`
      notes.push(`step ${n} reused the id "${id}", so it became "${renamed}" and arrows to "${id}" go to the first step with it`)
      id = renamed
    }
    ids.add(id)
    let line
    if (s.line !== undefined) {
      if (Number.isInteger(s.line) && s.line > 0) {
        line = s.line
      } else {
        notes.push(`step ${n} line ${JSON.stringify(s.line)} is not a line number, so it was left out`)
      }
    }
    parsed.push({
      id,
      title: stepTitle,
      file,
      line,
      symbol: field(s.symbol, LIMITS.symbol, `step ${n} symbol`),
      layer: field(s.layer, LIMITS.layer, `step ${n} layer`) ?? 'code',
      detail,
      why: field(s.why, LIMITS.why, `step ${n} why`),
      next: [],
      rawNext: s.next,
    })
  }

  // `next` left out means the step after; an arrow to an id no step has is dropped, and said so.
  for (const [i, step] of parsed.entries()) {
    const raw = step.rawNext
    delete step.rawNext
    if (raw === undefined) {
      step.next = i + 1 < parsed.length ? [{ id: parsed[i + 1].id }] : []
      continue
    }
    if (!Array.isArray(raw)) {
      notes.push(`step ${step.id} next is not a list, so it ends the flow`)
      continue
    }
    for (const entry of raw) {
      const id = typeof entry === 'string' ? entry : typeof entry?.id === 'string' ? entry.id : undefined
      if (id === undefined) {
        notes.push(`step ${step.id} has a next entry that is neither an id nor {id, when}; it was dropped`)
      } else if (!ids.has(id)) {
        notes.push(`step ${step.id} points to "${id}", which no step has; that arrow was dropped`)
      } else if (id === step.id) {
        notes.push(`step ${step.id} points to itself; that arrow was dropped`)
      } else if (step.next.length >= LIMITS.next) {
        notes.push(`step ${step.id} has more than ${LIMITS.next} next steps; "${id}" was dropped`)
      } else {
        const when = typeof entry === 'object' ? field(entry.when, LIMITS.when, `step ${step.id} arrow label`) : undefined
        step.next.push(when === undefined ? { id } : { id, when })
      }
    }
  }

  return {
    flow: {
      id: `f${at.toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      title,
      trigger,
      result: field(input.result, LIMITS.result, 'result'),
      steps: parsed,
      at,
    },
    notes,
  }
}

// Paths the tool accepts: relative, inside the project, never climbing out of it.
export function isInside(file) {
  return typeof file === 'string' && !file.startsWith('/') && !/^[A-Za-z]:/.test(file) && !file.split(/[\\/]/).includes('..')
}
