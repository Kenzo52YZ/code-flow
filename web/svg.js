// The flow as a picture: a column per layer, a row per step, and arrows to
// what follows. An arrow to the very next row curves straight down; one that
// skips rows runs down the gutter left of its column, so it never crosses a
// box; one back up (a retry, a loop) runs out to a margin on the right.

const LANE_WIDTH = 210
const BOX_HEIGHT = 46
const GAP = 26
const HEAD = 30
const PAD = 12
export const COLORS = ['#4f8ef7', '#f2a33a', '#3fb67b', '#d0598f', '#8a6ff0', '#e05a4f', '#2bb3c0', '#9a9a9a']

export function lanesOf(flow) {
  return [...new Set(flow.steps.map((s) => s.layer))]
}

export function flowSvg(flow, selected) {
  const lanes = lanesOf(flow)
  const index = new Map(flow.steps.map((s, i) => [s.id, i]))
  const backs = flow.steps.reduce((n, s, i) => n + s.next.filter((e) => (index.get(e.id) ?? i + 1) <= i).length, 0)
  const lanesWidth = PAD * 2 + lanes.length * LANE_WIDTH
  const width = lanesWidth + (backs > 0 ? 18 + backs * 8 : 0)
  const height = HEAD + PAD + flow.steps.length * (BOX_HEIGHT + GAP)
  const laneX = (s) => PAD + lanes.indexOf(s.layer) * LANE_WIDTH
  const boxX = (s) => laneX(s) + 8
  const boxY = (i) => HEAD + i * (BOX_HEIGHT + GAP)
  const boxW = LANE_WIDTH - 16
  const mid = (i) => boxY(i) + BOX_HEIGHT / 2
  const parts = []
  const labels = []
  let back = 0
  const gutterUse = new Map()

  for (const [i, lane] of lanes.entries()) {
    const color = COLORS[i % COLORS.length]
    const x = PAD + i * LANE_WIDTH
    parts.push(
      `<rect x="${x + 2}" y="4" width="${LANE_WIDTH - 4}" height="${height - 8}" rx="10" fill="${color}" fill-opacity="0.06"/>`,
      `<text x="${x + LANE_WIDTH / 2}" y="20" text-anchor="middle" font-size="12" font-weight="600" fill="${color}">${xml(cut(lane, 26))}</text>`,
    )
  }

  for (const [i, s] of flow.steps.entries()) {
    for (const edge of s.next) {
      const j = index.get(edge.id)
      const t = j === undefined ? undefined : flow.steps[j]
      if (t === undefined) {
        continue
      }
      let path
      let label
      if (j === i + 1) {
        const x1 = boxX(s) + boxW / 2
        const y1 = boxY(i) + BOX_HEIGHT
        const x2 = boxX(t) + boxW / 2
        const y2 = boxY(j)
        path = `M${x1},${y1} C${x1},${y1 + GAP} ${x2},${y2 - GAP} ${x2},${y2 - 2}`
        // By the arrowhead: under a source that also skips rows, its label holds the left.
        label = { x: x2 + 6, y: y2 - 7, anchor: 'start', max: 24 }
      } else if (j > i) {
        // Down the gutter left of the source's column, then across to the target.
        const lane = lanes.indexOf(s.layer)
        const used = gutterUse.get(lane) ?? 0
        gutterUse.set(lane, used + 1)
        const gx = laneX(s) + 5 - (used % 4) * 3
        const toLeft = boxX(t) + boxW < gx
        const endX = toLeft ? boxX(t) + boxW + 2 : boxX(t) - 2
        path = `M${boxX(s)},${mid(i)} H${gx} V${mid(j)} H${endX}`
        // Across columns, the label sits on the leg into the target; within one, that leg is too short,
        // so it goes under the source, left of where an arrow to the next row starts.
        label =
          t.layer === s.layer
            ? { x: boxX(s) + 6, y: boxY(i) + BOX_HEIGHT + 12, anchor: 'start', max: 14 }
            : toLeft
              ? { x: endX + 4, y: mid(j) - 5, anchor: 'start' }
              : { x: endX - 4, y: mid(j) - 5, anchor: 'end' }
      } else {
        const margin = lanesWidth + 8 + back * 8
        back += 1
        path = `M${boxX(s) + boxW},${mid(i)} H${margin} V${mid(j)} H${boxX(t) + boxW + 2}`
        label = { x: boxX(t) + boxW + 6, y: mid(j) - 5, anchor: 'start' }
      }
      parts.push(`<path d="${path}" fill="none" stroke="currentColor" stroke-opacity="0.5" stroke-width="1.5" marker-end="url(#arrow)"/>`)
      if (edge.when) {
        labels.push(`<text class="edge-label" x="${label.x}" y="${label.y}" text-anchor="${label.anchor}" font-size="10.5"><title>${xml(edge.when)}</title>${xml(cut(edge.when, label.max ?? 28))}</text>`)
      }
    }
  }

  for (const [i, s] of flow.steps.entries()) {
    const color = COLORS[lanes.indexOf(s.layer) % COLORS.length]
    const isOn = s.id === selected
    const isBad = s.isMissing === true || s.isPastEnd === true
    const where = `${s.file.split('/').at(-1) ?? s.file}${s.line === undefined ? '' : `:${s.line}`}`
    parts.push(
      `<g class="box" data-step="${xml(s.id)}" tabindex="0" role="button" aria-label="${xml(`Step ${i + 1}: ${s.title}`)}">`,
      `<title>${xml(`${s.title}\n${s.file}${s.line === undefined ? '' : `:${s.line}`}`)}</title>`,
      `<rect x="${boxX(s)}" y="${boxY(i)}" width="${boxW}" height="${BOX_HEIGHT}" rx="8" fill="${color}" fill-opacity="${isOn ? 0.38 : 0.16}" stroke="${isBad ? '#e05a4f' : color}" stroke-width="${isOn || isBad ? 2.5 : 1}"${isBad ? ' stroke-dasharray="5 3"' : ''}/>`,
      `<text x="${boxX(s) + 10}" y="${boxY(i) + 19}" font-size="12" font-weight="600" fill="currentColor">${xml(cut(`${i + 1}. ${s.title}`, 29))}</text>`,
      `<text x="${boxX(s) + 10}" y="${boxY(i) + 36}" font-size="11" fill="currentColor" fill-opacity="0.65">${xml(cut(where, 32))}</text>`,
      '</g>',
    )
  }

  return svg(width, height, [...parts, ...labels])
}

// A file between what uses it (left) and what it uses (right).
export function filesSvg(focus, importers, imports) {
  const shown = 12
  const left = importers.slice(0, shown)
  const right = imports.slice(0, shown)
  const rows = Math.max(left.length, right.length, 1) + (importers.length > shown || imports.length > shown ? 1 : 0)
  const rowH = 30
  const height = HEAD + rows * rowH + PAD
  const colW = 200
  const width = PAD * 2 + colW * 3 + 80
  const cx = PAD + colW + 40
  const cy = HEAD + ((rows - 1) * rowH) / 2
  const parts = [
    `<text x="${PAD + colW / 2}" y="18" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.7">Used by (${importers.length})</text>`,
    `<text x="${width - PAD - colW / 2}" y="18" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor" fill-opacity="0.7">Imports (${imports.length})</text>`,
  ]
  const node = (x, y, file, color, isMain = false) =>
    parts.push(
      `<g class="${isMain ? '' : 'box'}" data-file="${xml(file)}"><title>${xml(file)}</title>`,
      `<rect x="${x}" y="${y}" width="${colW}" height="24" rx="6" fill="${color}" fill-opacity="${isMain ? 0.3 : 0.14}" stroke="${color}"/>`,
      `<text x="${x + colW / 2}" y="${y + 16}" text-anchor="middle" font-size="11" ${isMain ? 'font-weight="600" ' : ''}fill="currentColor">${xml(cut(shortName(file), 30))}</text></g>`,
    )
  for (const [i, f] of left.entries()) {
    const y = HEAD + i * rowH
    parts.push(`<path d="M${PAD + colW},${y + 12} C${cx - 20},${y + 12} ${cx - 40},${cy + 12} ${cx},${cy + 12}" fill="none" stroke="currentColor" stroke-opacity="0.35" marker-end="url(#arrow)"/>`)
    node(PAD, y, f, COLORS[1])
  }
  for (const [i, f] of right.entries()) {
    const y = HEAD + i * rowH
    const x = width - PAD - colW
    parts.push(`<path d="M${cx + colW},${cy + 12} C${cx + colW + 40},${cy + 12} ${x - 20},${y + 12} ${x - 2},${y + 12}" fill="none" stroke="currentColor" stroke-opacity="0.35" marker-end="url(#arrow)"/>`)
    node(x, y, f, COLORS[2])
  }
  if (importers.length > shown || imports.length > shown) {
    const y = HEAD + (rows - 1) * rowH + 16
    parts.push(`<text x="${width / 2}" y="${y}" text-anchor="middle" font-size="11" fill="currentColor" fill-opacity="0.6">The lists below have them all</text>`)
  }
  node(cx, cy, focus, COLORS[0], true)
  return svg(width, height, parts)
}

export function shortName(path) {
  return path.split('/').slice(-2).join('/')
}

function svg(width, height, parts) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="system-ui, sans-serif">` +
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="currentColor" fill-opacity="0.6"/></marker></defs>' +
    parts.join('') +
    '</svg>'
  )
}

function cut(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
