import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const host = '0.0.0.0'
const port = Number(process.env.PLUGIN_PORT || 8080)
const pluginPath = resolve(import.meta.dirname, '../plugin/letterboxd-watchlist.js')
const plugin = await readFile(pluginPath)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PLUGIN_PORT must be an integer between 1 and 65535')
}

const server = createServer((request, response) => {
  if (request.url === '/letterboxd-watchlist.js') {
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Type': 'text/javascript; charset=utf-8',
    })
    response.end(plugin)
    return
  }

  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('ok')
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  response.end('Not found')
})

server.listen(port, host, () => {
  console.log(`Plugin is available at http://<LAN-IP>:${port}/letterboxd-watchlist.js`)
  console.log('Press Ctrl+C to stop the server')
})
