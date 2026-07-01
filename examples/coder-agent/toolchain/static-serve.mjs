import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(process.argv[2] ?? '.')
const requestedPort = Number.parseInt(process.argv[3] ?? '0', 10)
const host = '127.0.0.1'

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = http.createServer((request, response) => {
  const requestPath = new URL(request.url ?? '/', `http://${host}`).pathname
  const safePath = requestPath === '/' ? '/index.html' : requestPath
  const resolved = path.resolve(root, `.${safePath}`)
  if (!resolved.startsWith(root)) {
    response.writeHead(403)
    response.end('Forbidden')
    return
  }
  let filePath = resolved
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(root, 'index.html')
  }
  if (!fs.existsSync(filePath)) {
    response.writeHead(404)
    response.end('Not found')
    return
  }
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
  fs.createReadStream(filePath).pipe(response)
})

server.listen(requestedPort, host, () => {
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : requestedPort
  console.log(`READY http://${host}:${port}`)
})

server.on('error', err => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
