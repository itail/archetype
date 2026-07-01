import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  buildFocusContextInputs,
  renderFocusWorkItem,
  serializeContextBlock,
} from '../src/index.js'
import {
  listWorkspaceFileEntries,
  listWorkspaceMountFileEntries,
  renderWorkspaceFileEntries,
  renderWorkspaceMountFileContents,
  renderWorkspaceMountFileTree,
  resolveWorkspaceMountPath,
} from '../src/builder/index.js'

describe('focus context primitives', () => {
  it('builds intentful default context inputs', () => {
    const inputs = buildFocusContextInputs()
    expect(inputs.workItem.intent).toContain('Persona-authored future operating context')
    expect(inputs.workItem.intent).toContain('expert judgment lens')
    expect(inputs.workItem.intent).toContain('manageable reasoning decomposition')
    expect(inputs.workItem.intent).toContain('layered on source truth')
    expect(inputs.workItem.intent).toContain("does not replace them or another expert's ownership")
    expect(inputs.sourceContext.intent).toContain('Exact compact contents')
    expect(inputs.sourceContext.intent).toContain('planning')
    expect(inputs.sourceContext.intent).toContain('making tradeoffs')
    expect(inputs.sourceContext.intent).toContain('judging completeness')
    expect(inputs.workItem.priority).toBeUndefined()
    expect(inputs.workHistory.intent).toContain('Chronological')
    expect(inputs.files.intent).toContain('Factual workspace tree')
    expect(inputs.files.intent).toContain('private operating context layered on top of source truth')
    expect(inputs.environment.intent).toContain('runtime and workspace constraints')

    const rendered = serializeContextBlock('workItem', inputs.workItem, renderFocusWorkItem({
      artifactName: 'Spec Bundle',
      primaryGoal: 'Engineering can start.',
      constraints: ['Keep scope honest.'],
      mandatoryOutputs: ['Technical handoff'],
    }))
    expect(rendered).toContain('--- WORK ITEM ---')
    expect(rendered).not.toContain('[CRITICAL]')
    expect(rendered).toContain('Intent:')
    expect(rendered).toContain('Artifact: Spec Bundle')
  })

  it('lists workspace files with line and byte signals', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'archetype-focus-files-'))
    try {
      fs.writeFileSync(path.join(root, 'brief.md'), '# Brief\nLine two\n', 'utf8')
      const entries = listWorkspaceFileEntries(root)
      expect(entries).toEqual([{ path: 'brief.md', bytes: 17, lines: 3 }])
      expect(renderWorkspaceFileEntries(entries)).toEqual(['brief.md — 3 lines, 17 bytes'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lists and resolves virtual workspace mounts without nesting paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'archetype-focus-mounts-'))
    try {
      const specRoot = path.join(root, 'pm-spec')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(specRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(specRoot, 'brief.md'), '# Brief\n', 'utf8')
      fs.writeFileSync(path.join(artifactRoot, 'index.html'), '<h1>Game</h1>\n', 'utf8')

      const entries = listWorkspaceMountFileEntries([
        { prefix: 'spec', root: specRoot, writable: false },
        { prefix: 'artifact', root: artifactRoot },
      ])

      expect(renderWorkspaceFileEntries(entries)).toEqual([
        'spec/brief.md — 2 lines, 8 bytes, read-only',
        'artifact/index.html — 2 lines, 14 bytes, writable',
      ])
      expect(resolveWorkspaceMountPath({
        mounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot },
        ],
        requestPath: 'artifact/index.html',
      })).toMatchObject({
        relativePath: 'index.html',
        visiblePath: 'artifact/index.html',
      })

      expect(renderWorkspaceMountFileTree([
        { prefix: 'spec', root: specRoot, writable: false, purpose: 'product/spec documents' },
        { prefix: 'artifact', root: artifactRoot, purpose: 'browser game artifact' },
        { prefix: 'notes', root: path.join(root, 'notes') },
      ], { defaultMountPrefix: 'artifact' })).toEqual([
        'spec/ — read-only, product/spec documents',
        '  spec/brief.md — 2 lines, 8 bytes',
        'artifact/ — writable, browser game artifact',
        '  artifact/index.html — 2 lines, 14 bytes',
        'notes/ — writable, empty',
      ])

      expect(() => resolveWorkspaceMountPath({
        mounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot },
        ],
        requestPath: 'index.html',
        defaultMountPrefix: 'artifact',
      })).toThrow(/canonical visible workspace path/u)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('renders exact compact source file contents from mounted workspaces', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'archetype-focus-source-context-'))
    try {
      const inputRoot = path.join(root, 'input')
      const specRoot = path.join(root, 'spec')
      fs.mkdirSync(inputRoot, { recursive: true })
      fs.mkdirSync(specRoot, { recursive: true })
      fs.writeFileSync(path.join(inputRoot, 'brief.md'), '# Brief\n- mandatory feature\n', 'utf8')
      fs.writeFileSync(path.join(specRoot, 'large.md'), 'x'.repeat(40), 'utf8')

      const rendered = renderWorkspaceMountFileContents([
        { prefix: 'input', root: inputRoot, writable: false },
        { prefix: 'spec', root: specRoot },
      ], ['input/brief.md', 'spec/large.md', 'missing.md'], { maxBytesPerFile: 30 })

      expect(rendered).toContain('## input/brief.md')
      expect(rendered).toContain('- mandatory feature')
      expect(rendered).toContain('## spec/large.md')
      expect(rendered).toContain('content not inlined')
      expect(rendered).not.toContain('missing.md')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
