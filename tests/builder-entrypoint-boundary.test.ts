import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

describe('builder entrypoint boundary', () => {
  it('keeps optional browser implementation off the root entrypoint', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).not.toContain("export { PlaywrightBrowser } from './builder/browser.js'")
    expect(source).not.toMatch(/export\s+\{[^}]*\}\s+from '\.\/builder\/sandbox\.js'/u)
    expect(source).not.toMatch(/export\s+\{[^}]*\}\s+from '\.\/builder\/executor\.js'/u)
    expect(source).not.toMatch(/export\s+\{[^}]*\}\s+from '\.\/builder\/workspace-files\.js'/u)
    expect(source).toContain('from \'./builder/actions.js\'')
  })

  it('exposes node/browser builder implementations through the explicit builder subpath', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    expect(pkg.exports['./builder']).toEqual({
      import: './dist/builder/index.js',
      types: './dist/builder/index.d.ts',
    })

    const builderSource = readFileSync(new URL('../src/builder/index.ts', import.meta.url), 'utf8')
    expect(builderSource).toContain("export * from './browser.js'")
    expect(builderSource).toContain("export * from './sandbox.js'")
  })
})
