import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { PlaywrightBrowser } from '../src/builder/index.js'

const servers: Server[] = []

describe('PlaywrightBrowser', () => {
  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()!
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('reports console entries from the current navigation, not stale prior pages', async () => {
    let html = pageHtml('first navigation')
    const { origin } = await startServer(() => html)
    const browser = new PlaywrightBrowser({ allowedOrigin: origin })

    try {
      await browser.open('/')
      expect(browser.getConsoleEntries().map(entry => entry.text)).toContain('first navigation')

      html = pageHtml('second navigation')
      await browser.open('/')

      const entries = browser.getConsoleEntries().map(entry => entry.text)
      expect(entries).toContain('second navigation')
      expect(entries).not.toContain('first navigation')
    } finally {
      await browser.close()
    }
  })
})

function pageHtml(message: string) {
  return [
    '<!doctype html>',
    '<html>',
    '<body>',
    `<script>console.log(${JSON.stringify(message)});</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}

function startServer(render: () => string) {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(render())
  })
  servers.push(server)
  return new Promise<{ origin: string }>((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected TCP server address.'))
        return
      }
      resolve({ origin: `http://127.0.0.1:${address.port}` })
    })
  })
}
