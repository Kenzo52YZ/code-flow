// The MCP server Claude Code runs (over stdio): one tool, show_code_flow,
// which checks the trace against the project, keeps it, and shows it in the viewer.
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { checkFlow } from './check.js'
import { flowFrom, INPUT_SCHEMA, TOOL_DESCRIPTION } from './flow.js'
import { projectRoot, saveFlow } from './store.js'
import { announce, flowUrl, BASE } from './viewer.js'

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

// The project the files are relative to: the tool's `root`, then CODE_FLOW_ROOT, then the repository around the cwd.
function rootFor(args) {
  const given = typeof args.root === 'string' && args.root.trim() !== '' ? args.root.trim() : process.env.CODE_FLOW_ROOT
  return given ? path.resolve(given) : projectRoot(process.cwd())
}

export async function drawFlow(args, { show = announce } = {}) {
  const { flow, notes, problem } = flowFrom(args ?? {})
  if (flow === undefined) {
    return { text: `Not drawn: ${problem}`, isError: true }
  }
  const root = rootFor(args)
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { text: `Not drawn: the project folder ${root} does not exist. Pass the project's absolute path as root.`, isError: true }
  }
  const { missing, pastEnd } = checkFlow(root, flow)
  saveFlow(root, flow)
  const shown = await show(root, flow.id)
  const files = new Set(flow.steps.map((s) => s.file)).size
  const lines = [
    `Drawn "${flow.title}", ${flow.steps.length} steps, for ${root}.`,
    shown ? `Open it: ${flowUrl(root, flow.id)}` : `It is saved, but the viewer did not start: run \`code-flow serve\` and open ${BASE}.`,
  ]
  if (missing.length === 0 && pastEnd.length === 0) {
    lines.push(`All ${files} files were found, and every line is inside its file.`)
  }
  if (missing.length > 0) {
    lines.push(`These steps name files not found under ${root}: ${missing.map((s) => `${s.id} (${s.file})`).join(', ')}.`)
  }
  if (pastEnd.length > 0) {
    lines.push(`These steps' lines are past the end of their file: ${pastEnd.map(({ step, lines: n }) => `${step.id} (${step.file}:${step.line}, the file has ${n} lines)`).join(', ')}.`)
  }
  if (notes.length > 0) {
    lines.push(`Changed on the way: ${notes.join('; ')}.`)
  }
  if (missing.length > 0 || pastEnd.length > 0 || notes.length > 0) {
    lines.push('Fix these and call show_code_flow again with the same title to replace the drawing.')
  }
  return { text: lines.join('\n') }
}

export async function runMcp() {
  const server = new Server({ name: 'code-flow', version: VERSION }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'show_code_flow', description: TOOL_DESCRIPTION, inputSchema: INPUT_SCHEMA }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'show_code_flow') {
      return { content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }], isError: true }
    }
    try {
      const { text, isError } = await drawFlow(request.params.arguments)
      return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
    } catch (error) {
      return { content: [{ type: 'text', text: `Not drawn: ${error instanceof Error ? error.message : String(error)}` }], isError: true }
    }
  })
  await server.connect(new StdioServerTransport())
}
