import { describe, expect, it } from 'vitest'
import { filterNodeTestFilePaths, inferNodePackageTypeForTests, isNodeTestFilePath } from '../src/builder/node-test-discovery.js'

describe('node test discovery', () => {
  it('matches the files a builder reasonably expects runTests to execute', () => {
    expect(filterNodeTestFilePaths([
      'test.js',
      'test.mjs',
      'test.cjs',
      'game.test.js',
      'game.spec.mjs',
      'test/game.js',
      'tests/save-resume.cjs',
      'src/game.js',
      'artifact/app.js',
      'README.md',
    ])).toEqual([
      'game.spec.mjs',
      'game.test.js',
      'test.cjs',
      'test.js',
      'test.mjs',
      'test/game.js',
      'tests/save-resume.cjs',
    ])
  })

  it('keeps non-test application modules out of the preset', () => {
    expect(isNodeTestFilePath('artifact/app.js')).toBe(false)
    expect(isNodeTestFilePath('artifact/engine.mjs')).toBe(false)
    expect(isNodeTestFilePath('artifact/style.css')).toBe(false)
  })

  it('infers module package boundaries when discovered tests use ESM syntax', () => {
    expect(inferNodePackageTypeForTests([
      { path: 'test.js', content: 'import test from "node:test";\n' },
    ])).toBe('module')
    expect(inferNodePackageTypeForTests([
      { path: 'test.js', content: 'const test = require("node:test")\n' },
    ])).toBe('commonjs')
    expect(inferNodePackageTypeForTests([
      { path: 'game.test.mjs', content: 'const test = true\n' },
    ])).toBe('module')
  })
})
