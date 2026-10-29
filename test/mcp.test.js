import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const bin = path.join(import.meta.dirname, '..', 'bin', 'code-flow.js')

test('Claude Code can list the tool and draw a flow over stdio', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'code-flow-mcp-'))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bin, 'mcp'],
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, CODE_FLOW_HOME: home, CODE_FLOW_VIEWER: 'off' },
  })
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((t) => t.name),
      ['show_code_flow'],
    )
    const result = await client.callTool({
      name: 'show_code_flow',
      arguments: {
        title: 'The CLI starts the MCP server',
        trigger: 'Claude Code runs `code-flow mcp`',
        steps: [
          { title: 'Pick the command', file: 'bin/code-flow.js', line: 7, layer: 'CLI', detail: 'Reads the first argument.' },
          { title: 'Serve the tool', file: 'src/mcp.js', line: 1, layer: 'MCP', detail: 'Registers show_code_flow.', next: [] },
        ],
      },
    })
    const text = result.content[0].text
    // The root is the repository the server runs in: this one.
    assert.match(text, /Drawn "The CLI starts the MCP server", 2 steps/)
    assert.match(text, /All 2 files were found/)
    assert.match(text, /viewer did not start/)
  } finally {
    await client.close()
  }
})
