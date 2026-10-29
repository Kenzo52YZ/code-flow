#!/usr/bin/env node
// code-flow serve        the viewer, at http://127.0.0.1:4319 (CODE_FLOW_PORT to change it)
// code-flow mcp          the MCP server Claude Code runs; it starts the viewer when it draws
// code-flow open [dir]   adds a project to the viewer and opens it in the browser
import path from 'node:path'

const [command = 'serve', ...rest] = process.argv.slice(2)

if (command === 'serve') {
  const { runServer } = await import('../src/server.js')
  runServer()
} else if (command === 'mcp') {
  const { runMcp } = await import('../src/mcp.js')
  await runMcp()
} else if (command === 'open') {
  const { ensureViewer, flowUrl, BASE } = await import('../src/viewer.js')
  const { addProject, projectRoot } = await import('../src/store.js')
  const root = projectRoot(path.resolve(rest[0] ?? '.'))
  addProject(root)
  if (!(await ensureViewer())) {
    console.error(`The viewer did not start. Try \`code-flow serve\`, then open ${BASE}.`)
    process.exit(1)
  }
  const url = flowUrl(root)
  const { spawn } = await import('node:child_process')
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => console.log(url)).unref()
  console.log(url)
} else {
  console.error('Usage: code-flow [serve | mcp | open [dir]]')
  process.exit(1)
}
