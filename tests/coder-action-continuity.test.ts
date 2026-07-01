import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { buildActionsBlock } from '../src/core/actions.js'
import {
  coderActions,
  coderActionOutcomeForLedger,
  collectCoderActionAttachmentsForNextTurn,
  compactCoderActionOutcome,
  editFileAction,
  executeCoderAction,
  executeCoderActions,
  historyCoderActionOutcome,
  immediateCoderActionOutcome,
  SrtSandbox,
  type BrowserHarness,
  type CoderExecutorContext,
} from '../src/builder/index.js'

function createContext(workspaceRoot: string, overrides: Partial<CoderExecutorContext> = {}): CoderExecutorContext {
  return {
    workspaceRoot,
    browser: null,
    sandbox: {
      async runCommand() {
        return { ok: false, exitCode: 1, stdout: '', stderr: 'not enabled in test' }
      },
      async runTool() {
        return { ok: false, exitCode: 1, stdout: '', stderr: 'not enabled in test' }
      },
    },
    ...overrides,
  }
}

function withTempWorkspace(prefix: string, fn: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      rmSync(root, { recursive: true, force: true })
    })
}

describe('coder action continuity', () => {
  it('keeps same-turn applyPatch actions durable after a failed patch, then skips tests and finish', async () => {
    await withTempWorkspace('archetype-coder-batch-sequential-patches-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.html'), '<h1>Old</h1>\n', 'utf8')
      fs.writeFileSync(path.join(root, 'style.css'), 'body { color: black; }\n', 'utf8')
      const firstPatch = [
        'diff --git a/index.html b/index.html',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>Old</h1>',
        '+<h1>New</h1>',
        '',
      ].join('\n')
      const failingPatch = [
        'diff --git a/index.html b/index.html',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>Missing</h1>',
        '+<h1>Other</h1>',
        '',
      ].join('\n')
      const laterIndependentPatch = [
        'diff --git a/style.css b/style.css',
        '--- a/style.css',
        '+++ b/style.css',
        '@@ -1 +1 @@',
        '-body { color: black; }',
        '+body { color: blue; }',
        '',
      ].join('\n')

      const results = await executeCoderActions({
        actions: [
          { name: 'applyPatch', params: { patch: firstPatch } },
          { name: 'applyPatch', params: { patch: failingPatch } },
          { name: 'applyPatch', params: { patch: laterIndependentPatch } },
          { name: 'readFile', params: { path: 'index.html' } },
          { name: 'runTests', params: {} },
          { name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } },
        ],
        context: createContext(root),
      })

      expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe('<h1>New</h1>\n')
      expect(fs.readFileSync(path.join(root, 'style.css'), 'utf8')).toBe('body { color: blue; }\n')
      expect(results[0]?.result?.ok).toBe(true)
      expect(results[1]?.result?.ok).toBe(false)
      expect(results[2]?.result?.ok).toBe(true)
      expect(results[3]?.result?.ok).toBe(true)
      expect(results[4]?.result?.skipped).toBe(true)
      expect(results[4]?.result?.historyNote).toContain("Error: didn't run because tools/actions failed this turn")
      expect(results[5]?.result?.skipped).toBe(true)
      expect(results[5]?.result?.historyNote).toContain("Error: didn't run because tools/actions failed this turn")
    })
  })

  it('keeps successful file mutations when tests fail, then skips same-turn finishAttempt', async () => {
    await withTempWorkspace('archetype-coder-batch-sandbox-failure-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.html'), '<h1>Old</h1>\n', 'utf8')
      const patch = [
        'diff --git a/index.html b/index.html',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>Old</h1>',
        '+<h1>New</h1>',
        '',
      ].join('\n')

      const results = await executeCoderActions({
        actions: [
          { name: 'applyPatch', params: { patch } },
          { name: 'runTests', params: {} },
          { name: 'finishAttempt', params: { outcome: 'success', summary: 'done' } },
        ],
        context: createContext(root, {
          sandbox: {
            async runCommand() {
              return { ok: false, exitCode: 1, stdout: '', stderr: 'not enabled in test' }
            },
            async runTool() {
              return { ok: false, exitCode: 1, stdout: '', stderr: 'tests failed' }
            },
          },
        }),
      })

      expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe('<h1>New</h1>\n')
      expect(results[1]?.result?.kind).toBe('sandbox')
      expect(results[1]?.result?.ok).toBe(false)
      expect(results[2]?.result?.skipped).toBe(true)
      expect(results[2]?.result?.historyNote).toContain("Error: didn't run because tools/actions failed this turn")
    })
  })

  it('leaves unknown host actions to the host when no prior action failed', async () => {
    await withTempWorkspace('archetype-coder-batch-host-action-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.html'), '<h1>Old</h1>\n', 'utf8')
      const patch = [
        'diff --git a/index.html b/index.html',
        '--- a/index.html',
        '+++ b/index.html',
        '@@ -1 +1 @@',
        '-<h1>Old</h1>',
        '+<h1>New</h1>',
        '',
      ].join('\n')

      const results = await executeCoderActions({
        actions: [
          { name: 'applyPatch', params: { patch } },
          { name: 'returnToSession', params: { state: 'ready', message: 'ready' } },
        ],
        context: createContext(root),
      })

      expect(results[0]?.result?.ok).toBe(true)
      expect(results[1]?.result).toBeNull()
    })
  })

  it('returns immediate and stale continuity for readFile', async () => {
    await withTempWorkspace('archetype-coder-continuity-', async (root) => {
      fs.writeFileSync(path.join(root, 'brief.md'), '# The Last Lantern\nPlayer promise\n', 'utf8')
      const result = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'brief.md' } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('# The Last Lantern')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(result?.continuity?.staleText).toContain('read the file again only if exact contents are needed')
      expect(result?.continuity?.auditAnchors).toEqual(expect.arrayContaining(['brief.md', '# The Last Lantern']))
    })
  })

  it('returns failed action outcomes instead of throwing for invalid workspace paths', async () => {
    await withTempWorkspace('archetype-coder-invalid-path-', async (root) => {
      const inputRoot = path.join(root, 'input')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(inputRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(inputRoot, 'brief.md'), 'brief\n', 'utf8')

      const result = await executeCoderAction({
        action: { name: 'readFile', params: { path: '../input/brief.md' } },
        context: createContext(artifactRoot, {
          workspaceMounts: [
            { prefix: 'input', root: inputRoot, writable: false },
            { prefix: 'artifact', root: artifactRoot, writable: true },
          ],
          defaultMountPrefix: 'artifact',
        }),
      })

      expect(result).not.toBeNull()
      expect(result?.historyNote).toContain('readFile failed')
      expect(result?.historyNote).toContain('Use a visible path from FILES')
      expect(result?.historyNote).toContain('canonical visible workspace path')
      expect(result?.continuity?.resultText).toContain('readFile failed')
    })
  })

  it('provides an immediate outcome helper so hosts do not show stale tombstones too early', async () => {
    await withTempWorkspace('archetype-coder-immediate-outcome-', async (root) => {
      fs.writeFileSync(path.join(root, 'brief.md'), '# The Last Lantern\nPlayer promise\n', 'utf8')
      const result = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'brief.md' } },
        context: createContext(root),
      })

      expect(result).not.toBeNull()
      expect(immediateCoderActionOutcome(result!)).toContain('# The Last Lantern')
      expect(immediateCoderActionOutcome(result!)).not.toContain('removed from continuity')
    })
  })

  it('provides a compact shared outcome helper that does not leak read payloads', async () => {
    await withTempWorkspace('archetype-coder-compact-outcome-', async (root) => {
      fs.writeFileSync(path.join(root, 'brief.md'), '# The Last Lantern\nPlayer promise\n', 'utf8')
      const read = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'brief.md' } },
        context: createContext(root),
      })
      const write = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'notes.md', content: 'small note\n' } },
        context: createContext(root),
      })

      expect(read).not.toBeNull()
      expect(write).not.toBeNull()
      expect(compactCoderActionOutcome(read!)).toContain('readFile result for brief.md no longer carried')
      expect(compactCoderActionOutcome(read!)).not.toContain('# The Last Lantern')
      expect(compactCoderActionOutcome(write!)).toContain('writeFile notes.md')
      expect(compactCoderActionOutcome(write!)).toContain('Successfully wrote')
      expect(compactCoderActionOutcome(write!)).not.toContain('small note')
    })
  })

  it('keeps small chat-history outcomes attached while decaying large results', async () => {
    await withTempWorkspace('archetype-coder-history-outcome-', async (root) => {
      fs.writeFileSync(path.join(root, 'brief.md'), `${'# The Last Lantern\n'.repeat(300)}\n`, 'utf8')
      const list = await executeCoderAction({
        action: { name: 'listFiles', params: { path: '.' } },
        context: createContext(root),
      })
      const read = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'brief.md' } },
        context: createContext(root),
      })

      expect(list).not.toBeNull()
      expect(read).not.toBeNull()
      expect(historyCoderActionOutcome(list!)).toContain('brief.md')
      expect(historyCoderActionOutcome(list!)).not.toContain('removed from continuity')
      expect(historyCoderActionOutcome(read!)).toContain('readFile result for brief.md no longer carried')
      expect(historyCoderActionOutcome(read!)).not.toContain('# The Last Lantern')
    })
  })

  it('readFile returns a visible missing-file sentinel instead of throwing', async () => {
    await withTempWorkspace('archetype-coder-read-missing-', async (root) => {
      const result = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'missing.md' } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('(file missing: missing.md)')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(result?.continuity?.staleText).toContain('read the file again only if exact contents are needed')
    })
  })

  it('returns immediate and stale continuity for searchInFiles matches', async () => {
    await withTempWorkspace('archetype-coder-search-', async (root) => {
      fs.writeFileSync(path.join(root, 'notes.md'), 'trust system replaces stealth\n', 'utf8')
      const result = await executeCoderAction({
        action: { name: 'searchInFiles', params: { pattern: 'trust' } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('notes.md:1: trust system replaces stealth')
      expect(result?.continuity?.resultText).toContain('literal matches')
      expect(result?.continuity?.staleText).toContain('run searchInFiles again')
      expect(result?.continuity?.auditAnchors).toEqual(expect.arrayContaining(['trust', 'notes.md:1: trust system replaces stealth']))
    })
  })

  it('searchInFiles reports no matches and invalid regexes as action results', async () => {
    await withTempWorkspace('archetype-coder-search-edge-', async (root) => {
      fs.writeFileSync(path.join(root, 'notes.md'), 'lantern only\n', 'utf8')
      const noMatches = await executeCoderAction({
        action: { name: 'searchInFiles', params: { pattern: 'companion' } },
        context: createContext(root),
      })
      expect(noMatches?.continuity?.resultText).toContain('(no matches)')
      expect(noMatches?.continuity?.staleText).toContain('run searchInFiles again')

      const invalid = await executeCoderAction({
        action: { name: 'searchInFiles', params: { pattern: '[' } },
        context: createContext(root),
      })
      expect(invalid?.continuity?.resultText).toContain('failed')
      expect(invalid?.historyNote).toContain('did not parse')
    })
  })

  it('reports writeFile mutations without carrying file bodies', async () => {
    await withTempWorkspace('archetype-coder-write-', async (root) => {
      const content = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n')
      const result = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'spec.md', content } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('writeFile spec.md')
      expect(result?.continuity?.resultText).toContain('Successfully wrote')
      expect(result?.continuity?.resultText).toContain('20 lines')
      expect(result?.continuity?.resultText).toContain('Exact file content is not carried')
      expect(result?.continuity?.resultText).not.toContain('line 1')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(result?.continuity?.staleText).toContain('Exact file content is not carried')
      expect(fs.readFileSync(path.join(root, 'spec.md'), 'utf8')).toBe(content)
    })
  })

  it('exposes writeFile for whole-file writes and applyPatch for targeted git-style patches', () => {
    expect(coderActions.writeFile.description).toContain('Create or overwrite a whole file')
    expect(coderActions.writeFile.description).toContain('exact file content is not carried')
    expect(coderActions.applyPatch.description).toContain('git-style unified diff patch')
    expect(coderActions.applyPatch.description).toContain('workspace write surface')
    expect(coderActions.applyPatch.description).toContain('exact current file context')
    expect(coderActions.applyPatch.description).toContain('consider readFile first')
    expect(coderActions.applyPatch.description).toContain('its result is added to your next prompt')
    expect(coderActions.applyPatch.description).toContain('outcome explains the failed contract')
    expect(coderActions.applyPatch.description).toContain('One applyPatch call is one atomic file transaction')
    expect(coderActions.applyPatch.description).toContain('edits that must stay consistent')
    expect(coderActions.applyPatch.description).toContain('multiple applyPatch actions in one turn')
    expect(coderActions.applyPatch.description).toContain('earlier successful applyPatch remains applied')
    expect(coderActions.applyPatch.description).toContain('Split edits into separate applyPatch actions')
    expect(editFileAction.description).toContain('oldText must match the current file contents exactly')
    expect(editFileAction.description).toContain('consider readFile first')
    expect(editFileAction.description).toContain('its result is added to your next prompt')
    expect(coderActions.applyPatch.schema.safeParse({
      patch: '--- /dev/null\n+++ README.md\n@@ -0,0 +1 @@\n+# Readme\n',
    }).success).toBe(true)
    expect(coderActions.applyPatch.schema.safeParse({
      changes: [{ path: 'README.md', content: '# Readme\n' }],
    }).success).toBe(false)
    expect(coderActions.applyPatch.schema.safeParse({
      patch: '--- README.md\n+++ README.md\n@@ -1 +1 @@\n-old\n+new\n',
      changes: [{ path: 'README.md', content: '# Readme\n' }],
    }).success).toBe(false)
    const actionsBlock = buildActionsBlock({
      writeFile: coderActions.writeFile,
      applyPatch: coderActions.applyPatch,
    }, 'conversation', 'lean')
    expect(actionsBlock).toContain('writeFile')
    expect(actionsBlock).toContain('Create or overwrite a whole file')
    expect(actionsBlock).toContain('patch')
    expect(actionsBlock).toContain('git-style unified diff patch')
    expect(actionsBlock).toContain('consider readFile first')
    expect(actionsBlock).toContain('One applyPatch call is one atomic file transaction')
    expect(actionsBlock).toContain('multiple applyPatch actions in one turn')
    expect(actionsBlock).toContain('actions are attempts')
    expect(actionsBlock).toContain('any action can succeed or fail')
    expect(actionsBlock).toContain('before any action outcomes are known')
    expect(actionsBlock).toContain('A same-turn visible completion, verification, or handoff message cannot reflect outcomes you have not seen yet.')
    expect(actionsBlock).not.toContain('changes[]')
    expect(actionsBlock).not.toContain('oldText')
    expect(actionsBlock).toContain('example: {"name":"applyPatch","params":{"patch"')
    expect(Object.keys(coderActions)).toContain('applyPatch')
    expect(Object.keys(coderActions)).toContain('writeFile')
    expect(Object.keys(coderActions)).not.toContain('editFile')
    expect(Object.keys(coderActions)).not.toContain('deleteFile')
  })

  it('documents focus action timing as factual continuity instead of same-turn certainty', () => {
    const actionsBlock = buildActionsBlock({
      browserClick: coderActions.browserClick,
      browserScreenshot: coderActions.browserScreenshot,
      finishAttempt: coderActions.finishAttempt,
      returnToSession: coderActions.returnToSession,
    }, 'focus', 'lean')

    expect(actionsBlock).toContain('Actions are attempts')
    expect(actionsBlock).toContain('any file, browser, test, finish, or handoff action can succeed or fail')
    expect(actionsBlock).toContain('before seeing same-turn outcomes')
    expect(actionsBlock).toContain('failed clicks')
    expect(actionsBlock).toContain('skipped finish attempts')
    expect(actionsBlock).toContain('A same-turn visible completion, verification, or handoff message cannot reflect outcomes you have not seen yet.')
    expect(actionsBlock).toContain('If the message depends on verification actions in this turn, run the verification first, let the outcomes return in the next turn, then decide what to say.')
  })

  it('documents Node test visibility for browser-targeted artifacts', () => {
    expect(coderActions.runTests.description).toContain('browser APIs')
    expect(coderActions.runTests.description).toContain('temporary package boundary')
    expect(coderActions.runTests.description).toContain('infers module vs CommonJS')
    expect(coderActions.runTests.description).toContain('globalThis/window')
    expect(coderActions.runTests.description).toContain('top-level browser-script locals')
    expect(coderActions.runTests.description).toContain('static imports execute before test-file setup')
    expect(coderActions.runTests.description).toContain('dynamic `await import(...)`')
  })

  it('applyPatch edits, creates, and deletes files through git apply with factual continuity', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.md'), 'alpha\nbeta\n', 'utf8')
      fs.writeFileSync(path.join(root, 'old.md'), 'remove me\n', 'utf8')
      const patch = [
        'diff --git a/index.md b/index.md',
        '--- a/index.md',
        '+++ b/index.md',
        '@@ -1,2 +1,2 @@',
        ' alpha',
        '-beta',
        '+gamma',
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1,2 @@',
        '+# New',
        '+created',
        'diff --git a/old.md b/old.md',
        'deleted file mode 100644',
        '--- a/old.md',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-remove me',
        '',
      ].join('\n')
      const result = await executeCoderAction({
        action: { name: 'applyPatch', params: { patch } },
        context: createContext(root),
      })

      expect(result?.mutatedArtifact).toBe(true)
      expect(result?.continuity?.resultText).toContain('Successfully applied patch to 3 files')
      expect(result?.continuity?.resultText).toContain('index.md — 2 lines')
      expect(result?.continuity?.resultText).toContain('new.md — 2 lines')
      expect(result?.continuity?.resultText).toContain('old.md — deleted')
      expect(result?.continuity?.resultText).toContain('Exact file contents are not carried')
      expect(result?.continuity?.resultText).not.toContain('gamma')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(fs.readFileSync(path.join(root, 'index.md'), 'utf8')).toBe('alpha\ngamma\n')
      expect(fs.readFileSync(path.join(root, 'new.md'), 'utf8')).toBe('# New\ncreated\n')
      expect(fs.existsSync(path.join(root, 'old.md'))).toBe(false)
    })
  })

  it('applyPatch is atomic when the patch does not apply cleanly', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-atomic-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.md'), 'alpha\nbeta\n', 'utf8')
      const patch = [
        'diff --git a/index.md b/index.md',
        '--- a/index.md',
        '+++ b/index.md',
        '@@ -1,2 +1,2 @@',
        ' alpha',
        '-missing',
        '+gamma',
        'diff --git a/new.md b/new.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.md',
        '@@ -0,0 +1 @@',
        '+created',
        '',
      ].join('\n')
      const result = await executeCoderAction({
        action: { name: 'applyPatch', params: { patch } },
        context: createContext(root),
      })

      expect(result?.mutatedArtifact).toBeUndefined()
      expect(result?.continuity?.resultText).toContain('applyPatch failed; no files were changed.')
      expect(result?.continuity?.resultText).toContain('Reason: patch context did not match the current workspace state.')
      expect(result?.continuity?.resultText).toContain('The patch expected lines or file state that are not present exactly as written.')
      expect(result?.continuity?.resultText).toContain('- index.md')
      expect(result?.continuity?.resultText).toContain('- new.md')
      expect(result?.continuity?.resultText).toContain('Recovery: read the affected file(s) if exact current contents are not already in this prompt')
      expect(result?.continuity?.resultText).not.toContain('use writeFile if you intend to replace a whole file')
      expect(result?.continuity?.resultText).toContain('Git detail:')
      expect(result?.continuity?.resultText).toContain('patch does not apply')
      expect(fs.readFileSync(path.join(root, 'index.md'), 'utf8')).toBe('alpha\nbeta\n')
      expect(fs.existsSync(path.join(root, 'new.md'))).toBe(false)
    })
  })

  it('applyPatch failure explains stale context without carrying the patch body', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-diagnostic-', async (root) => {
      fs.writeFileSync(path.join(root, 'app.js'), 'const title = "Current"\nexport { title }\n', 'utf8')
      const patch = [
        'diff --git a/app.js b/app.js',
        '--- a/app.js',
        '+++ b/app.js',
        '@@ -1,2 +1,2 @@',
        '-const title = "Stale assumption"',
        '+const title = "Clockwork Courier"',
        ' export { title }',
        '',
      ].join('\n')

      const result = await executeCoderAction({
        action: { name: 'applyPatch', params: { patch } },
        context: createContext(root),
      })

      const note = result?.continuity?.resultText ?? ''
      expect(note).toContain('patch context did not match')
      expect(note).toContain('app.js')
      expect(note).toContain('read the affected file(s) if exact current contents are not already in this prompt')
      expect(note).not.toContain('use writeFile if you intend to replace a whole file')
      expect(note).not.toContain('Clockwork Courier')
      expect(note).not.toContain('Stale assumption')
      expect(fs.readFileSync(path.join(root, 'app.js'), 'utf8')).toBe('const title = "Current"\nexport { title }\n')
    })
  })

  it('writeFile is the compact whole-file path for large known contents', async () => {
    await withTempWorkspace('archetype-coder-write-large-', async (root) => {
      const content = [
        '<!DOCTYPE html>',
        '<html>',
        '<body>',
        ...Array.from({ length: 120 }, (_, index) => `<p>line ${index + 1}</p>`),
        '<script>if (!window.ready) window.ready = true</script>',
        '</body>',
        '</html>',
        '',
      ].join('\n')

      const result = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'index.html', content } },
        context: createContext(root),
      })

      const note = result?.continuity?.resultText ?? ''
      expect(note).toContain('writeFile index.html')
      expect(note).toContain('Successfully wrote')
      expect(note).toContain('lines')
      expect(note).toContain('Exact file content is not carried')
      expect(note).not.toContain('<!DOCTYPE html>')
      expect(note).not.toContain('!window.ready')
      expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe(content)
    })
  })

  it('applyPatch applies relative to the workspace root even inside a parent git repo', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-parent-git-', async (root) => {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' })
      const workspace = path.join(root, 'nested-workspace')
      fs.mkdirSync(workspace, { recursive: true })
      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              'diff --git a/index.html b/index.html',
              'new file mode 100644',
              '--- /dev/null',
              '+++ b/index.html',
              '@@ -0,0 +1 @@',
              '+<h1>Workspace local</h1>',
              '',
            ].join('\n'),
          },
        },
        context: createContext(workspace),
      })

      expect(result?.continuity?.resultText).toContain('index.html — 1 line')
      expect(result?.continuity?.resultText).toContain('Exact file contents are not carried')
      expect(fs.readFileSync(path.join(workspace, 'index.html'), 'utf8')).toBe('<h1>Workspace local</h1>\n')
      expect(fs.existsSync(path.join(root, 'index.html'))).toBe(false)
    })
  })

  it('applyPatch accepts common unified diffs for new files without git metadata headers', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-plain-new-files-', async (root) => {
      const patch = [
        '--- /dev/null',
        '+++ package.json',
        '@@ -0,0 +1,3 @@',
        '+{',
        '+  "type": "module"',
        '+}',
        '--- /dev/null',
        '+++ src/index.js',
        '@@ -0,0 +1 @@',
        '+console.log("ok");',
        '',
      ].join('\n')
      const result = await executeCoderAction({
        action: { name: 'applyPatch', params: { patch } },
        context: createContext(root),
      })

      expect(result?.mutatedArtifact).toBe(true)
      expect(result?.continuity?.resultText).toContain('Successfully applied patch to 2 files')
      expect(result?.continuity?.resultText).toContain('package.json — 3 lines')
      expect(result?.continuity?.resultText).toContain('src/index.js — 1 line')
      expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('{\n  "type": "module"\n}\n')
      expect(fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')).toBe('console.log("ok");\n')
    })
  })

  it('applyPatch accepts git-style new file diffs that omit explicit file mode', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-git-new-no-mode-', async (root) => {
      const patch = [
        'diff --git a/product-spec.md b/product-spec.md',
        '--- /dev/null',
        '+++ b/product-spec.md',
        '@@ -0,0 +1,2 @@',
        '+# Product Spec',
        '+Created through a normal git-style new-file patch.',
        '',
      ].join('\n')
      const result = await executeCoderAction({
        action: { name: 'applyPatch', params: { patch } },
        context: createContext(root),
      })

      expect(result?.mutatedArtifact).toBe(true)
      expect(result?.continuity?.resultText).toContain('Successfully applied patch to 1 file')
      expect(result?.continuity?.resultText).toContain('product-spec.md — 2 lines')
      expect(result?.continuity?.resultText).not.toContain('dev/null')
      expect(fs.readFileSync(path.join(root, 'product-spec.md'), 'utf8')).toBe('# Product Spec\nCreated through a normal git-style new-file patch.\n')
    })
  })

  it('applyPatch preserves paths from unified diffs that omit a/ and b/ prefixes', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-no-prefix-', async (root) => {
      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              '--- /dev/null',
              '+++ src/index.js',
              '@@ -0,0 +1 @@',
              '+console.log("nested");',
              '',
            ].join('\n'),
          },
        },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('src/index.js')
      expect(fs.readFileSync(path.join(root, 'src', 'index.js'), 'utf8')).toBe('console.log("nested");\n')
      expect(fs.existsSync(path.join(root, 'index.js'))).toBe(false)
    })
  })

  it('applyPatch recounts hunk headers for hand-authored unified diffs', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-recount-', async (root) => {
      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              '--- /dev/null',
              '+++ README.md',
              '@@ -0,0 +1,1 @@',
              '+# Clockwork Courier',
              '+',
              '+Two body lines even though the header count says one.',
              '',
            ].join('\n'),
          },
        },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('Successfully applied patch')
      expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe([
        '# Clockwork Courier',
        '',
        'Two body lines even though the header count says one.',
        '',
      ].join('\n'))
    })
  })

  it('applyPatch accepts unterminated hand-authored patches after recounting hunk headers', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-recount-eof-', async (root) => {
      const patch = [
        'diff --git a/product-spec.md b/product-spec.md',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/product-spec.md',
        '@@ -0,0 +1,9 @@',
        '+# Clockwork Courier - Product Spec',
        '+',
        '+## Overview',
        '+A turn-based grid strategy game.',
      ].join('\n')

      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: { patch },
        },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('Successfully applied patch')
      expect(fs.readFileSync(path.join(root, 'product-spec.md'), 'utf8')).toBe([
        '# Clockwork Courier - Product Spec',
        '',
        '## Overview',
        'A turn-based grid strategy game.',
        '',
      ].join('\n'))
    })
  })

  it('applyPatch appends after final context when the target file has no trailing newline', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-inaccurate-eof-', async (root) => {
      fs.writeFileSync(path.join(root, 'styles.css'), [
        '.cell {',
        '  display: flex;',
        '  align-items: center;',
        '}',
      ].join('\n'), 'utf8')

      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              'diff --git a/styles.css b/styles.css',
              '--- a/styles.css',
              '+++ b/styles.css',
              '@@ -1,4 +1,9 @@',
              ' .cell {',
              '   display: flex;',
              '   align-items: center;',
              ' }',
              '+',
              '+.overlay {',
              '+  position: absolute;',
              '+}',
              '',
            ].join('\n'),
          },
        },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('Successfully applied patch')
      expect(fs.readFileSync(path.join(root, 'styles.css'), 'utf8')).toBe([
        '.cell {',
        '  display: flex;',
        '  align-items: center;',
        '}',
        '',
        '.overlay {',
        '  position: absolute;',
        '}',
      ].join('\n'))
    })
  })

  it('applyPatch maps visible mount paths to the writable backing root', async () => {
    await withTempWorkspace('archetype-coder-apply-patch-mount-', async (root) => {
      const specRoot = path.join(root, 'spec')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(specRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(artifactRoot, 'index.html'), '<h1>Old</h1>\n', 'utf8')
      fs.writeFileSync(path.join(specRoot, 'brief.md'), '# Brief\n', 'utf8')
      const context = createContext(artifactRoot, {
        workspaceMounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot, writable: true },
        ],
        defaultMountPrefix: 'artifact',
      })

      const result = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              'diff --git a/artifact/index.html b/artifact/index.html',
              '--- a/artifact/index.html',
              '+++ b/artifact/index.html',
              '@@ -1 +1 @@',
              '-<h1>Old</h1>',
              '+<h1>New</h1>',
              '',
            ].join('\n'),
          },
        },
        context,
      })
      expect(result?.continuity?.resultText).toContain('artifact/index.html')
      expect(fs.readFileSync(path.join(artifactRoot, 'index.html'), 'utf8')).toBe('<h1>New</h1>\n')
      expect(fs.existsSync(path.join(artifactRoot, 'artifact', 'index.html'))).toBe(false)

      const blocked = await executeCoderAction({
        action: {
          name: 'applyPatch',
          params: {
            patch: [
              'diff --git a/spec/brief.md b/spec/brief.md',
              '--- a/spec/brief.md',
              '+++ b/spec/brief.md',
              '@@ -1 +1 @@',
              '-# Brief',
              '+# Changed',
              '',
            ].join('\n'),
          },
        },
        context,
      })
      expect(blocked?.continuity?.resultText).toContain('read-only workspace mount')
      expect(fs.readFileSync(path.join(specRoot, 'brief.md'), 'utf8')).toBe('# Brief\n')
    })
  })

  it('writeFile creates nested directories and deleteFile removes files with concise continuity', async () => {
    await withTempWorkspace('archetype-coder-write-delete-', async (root) => {
      const write = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'docs/spec.md', content: '# Spec\n' } },
        context: createContext(root),
      })
      expect(write?.mutatedArtifact).toBe(true)
      expect(fs.existsSync(path.join(root, 'docs', 'spec.md'))).toBe(true)

      const del = await executeCoderAction({
        action: { name: 'deleteFile', params: { path: 'docs/spec.md' } },
        context: createContext(root),
      })
      expect(del?.continuity?.resultText).toContain('Successfully deleted')
      expect(fs.existsSync(path.join(root, 'docs', 'spec.md'))).toBe(false)
    })
  })

  it('routes file actions through virtual workspace mounts and keeps visible paths stable', async () => {
    await withTempWorkspace('archetype-coder-mounts-', async (root) => {
      const specRoot = path.join(root, 'pm-spec')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(specRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(specRoot, 'brief.md'), '# Spec Brief\n', 'utf8')

      const context = createContext(artifactRoot, {
        workspaceMounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot, writable: true },
        ],
        defaultMountPrefix: 'artifact',
      })

      const read = await executeCoderAction({
        action: { name: 'readFile', params: { path: 'spec/brief.md' } },
        context,
      })
      expect(read?.continuity?.resultText).toContain('readFile spec/brief.md')
      expect(read?.continuity?.resultText).toContain('# Spec Brief')

      const write = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'artifact/index.html', content: '<h1>Game</h1>' } },
        context,
      })
      expect(write?.continuity?.resultText).toContain('writeFile artifact/index.html')
      expect(fs.existsSync(path.join(artifactRoot, 'index.html'))).toBe(true)
      expect(fs.existsSync(path.join(artifactRoot, 'artifact', 'index.html'))).toBe(false)

      const blocked = await executeCoderAction({
        action: { name: 'writeFile', params: { path: 'spec/brief.md', content: 'overwrite' } },
        context,
      })
      expect(blocked?.continuity?.resultText).toContain('read-only workspace mount')
      expect(fs.readFileSync(path.join(specRoot, 'brief.md'), 'utf8')).toBe('# Spec Brief\n')
    })
  })

  it('listFiles and searchInFiles expose virtual mount prefixes', async () => {
    await withTempWorkspace('archetype-coder-mount-list-', async (root) => {
      const specRoot = path.join(root, 'spec')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(specRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(specRoot, 'brief.md'), 'courier promise\n', 'utf8')
      fs.writeFileSync(path.join(artifactRoot, 'game.js'), 'const courier = true\n', 'utf8')

      const context = createContext(artifactRoot, {
        workspaceMounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot },
        ],
        defaultMountPrefix: 'artifact',
      })

      const list = await executeCoderAction({
        action: { name: 'listFiles', params: {} },
        context,
      })
      expect(list?.continuity?.resultText).toContain('spec/brief.md')
      expect(list?.continuity?.resultText).toContain('artifact/game.js')

      const search = await executeCoderAction({
        action: { name: 'searchInFiles', params: { pattern: 'courier' } },
        context,
      })
      expect(search?.continuity?.resultText).toContain('spec/brief.md:1: courier promise')
      expect(search?.continuity?.resultText).toContain('artifact/game.js:1: const courier = true')
    })
  })

  it('returns browserOpen failures as action outcomes instead of throwing', async () => {
    await withTempWorkspace('archetype-coder-browser-open-fail-', async (root) => {
      const browser: BrowserHarness = {
        async open() {
          throw new Error('Browser navigation blocked outside allowed origin: http://localhost:8000/')
        },
        async screenshot() {
          throw new Error('unused')
        },
        async click() {
          return { ok: false, matched: 'none', detail: 'unused' }
        },
        async type() {
          return { ok: false, detail: 'unused' }
        },
        async key() {
          return { ok: false, detail: 'unused' }
        },
        getConsoleEntries() {
          return []
        },
        async close() {},
      }

      const result = await executeCoderAction({
        action: { name: 'browserOpen', params: { path: 'http://localhost:8000/' } },
        context: createContext(root, { browser }),
      })

      expect(result?.continuity?.resultText).toContain('browserOpen failed')
      expect(result?.continuity?.resultText).toContain('outside allowed origin')
    })
  })

  it('returns immediate and stale continuity for listFiles', async () => {
    await withTempWorkspace('archetype-coder-list-', async (root) => {
      fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
      fs.writeFileSync(path.join(root, 'docs', 'overview.md'), '# Overview\n', 'utf8')
      const result = await executeCoderAction({
        action: { name: 'listFiles', params: { path: 'docs' } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('listFiles docs')
      expect(result?.continuity?.resultText).toContain('overview.md')
      expect(result?.continuity?.staleText).toContain('run listFiles again')
    })
  })

  it('listFiles returns an empty listing for missing or empty directories', async () => {
    await withTempWorkspace('archetype-coder-list-empty-', async (root) => {
      const result = await executeCoderAction({
        action: { name: 'listFiles', params: { path: 'missing-dir' } },
        context: createContext(root),
      })

      expect(result?.continuity?.resultText).toContain('(empty)')
      expect(result?.continuity?.staleText).toContain('run listFiles again')
    })
  })

  it('returns factual continuity when editFile oldText misses and leaves the file unchanged', async () => {
    await withTempWorkspace('archetype-coder-edit-miss-', async (root) => {
      fs.writeFileSync(path.join(root, 'index.md'), '# Index\n\n- Existing entry\n', 'utf8')
      const result = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'index.md',
            edits: [{ oldText: '- Missing entry', newText: '- Replacement entry' }],
          },
        },
        context: createContext(root),
      })

      expect(fs.readFileSync(path.join(root, 'index.md'), 'utf8')).toBe('# Index\n\n- Existing entry\n')
      expect(result?.historyNote).toContain('failed')
      expect(result?.historyNote).toContain('no edits applied')
      expect(result?.continuity?.resultText).toContain('oldText did not match')
      expect(result?.continuity?.resultText).toContain('Current file content not carried')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(result?.continuity?.staleText).toContain('Current file content no longer carried')
      expect(result?.continuity?.auditAnchors).toEqual(expect.arrayContaining(['index.md']))
    })
  })

  it('editFile applies all edits in one atomic call when every span matches', async () => {
    await withTempWorkspace('archetype-coder-edit-multi-success-', async (root) => {
      fs.writeFileSync(path.join(root, 'spec.md'), 'alpha\nbeta\ngamma\n', 'utf8')
      const result = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'spec.md',
            edits: [
              { oldText: 'alpha', newText: 'ALPHA' },
              { oldText: 'beta', newText: 'BETA' },
              { oldText: 'gamma', newText: 'GAMMA' },
            ],
          },
        },
        context: createContext(root),
      })

      expect(fs.readFileSync(path.join(root, 'spec.md'), 'utf8')).toBe('ALPHA\nBETA\nGAMMA\n')
      expect(result?.continuity?.resultText).toContain('Successfully replaced 3 block')
      expect(result?.continuity?.resultText).toContain('Current file content not carried')
      expect(result?.continuity?.resultTurns).toBe(4)
      expect(result?.continuity?.staleText).toContain('Current file content no longer carried')
    })
  })

  it('editFile does not partially apply a multi-edit action when any span misses', async () => {
    await withTempWorkspace('archetype-coder-edit-multi-atomic-', async (root) => {
      fs.writeFileSync(path.join(root, 'spec.md'), 'alpha\nbeta\ngamma\n', 'utf8')
      const result = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'spec.md',
            edits: [
              { oldText: 'alpha', newText: 'ALPHA' },
              { oldText: 'missing', newText: 'MISSING' },
              { oldText: 'gamma', newText: 'GAMMA' },
            ],
          },
        },
        context: createContext(root),
      })

      expect(fs.readFileSync(path.join(root, 'spec.md'), 'utf8')).toBe('alpha\nbeta\ngamma\n')
      expect(result?.continuity?.resultText).toContain('failed — no edits applied')
      expect(result?.continuity?.resultText).toContain('edits[1]')
    })
  })

  it('editFile can target a specific occurrence when exact text is duplicated', async () => {
    await withTempWorkspace('archetype-coder-edit-occurrence-', async (root) => {
      fs.writeFileSync(path.join(root, 'main.js'), [
        'function duplicated() {',
        '  return "first"',
        '}',
        '',
        'function keep() {',
        '  return true',
        '}',
        '',
        'function duplicated() {',
        '  return "first"',
        '}',
        '',
      ].join('\n'), 'utf8')

      const ambiguous = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'main.js',
            edits: [{ oldText: 'function duplicated() {\n  return "first"\n}', newText: '' }],
          },
        },
        context: createContext(root),
      })
      expect(ambiguous?.continuity?.resultText).toContain('oldText matches 2 times')
      expect(ambiguous?.continuity?.resultText).toContain('#1 line 1')
      expect(ambiguous?.continuity?.resultText).toContain('#2 line 9')
      expect(ambiguous?.continuity?.resultText).toContain('set occurrence')

      const targeted = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'main.js',
            edits: [{ oldText: 'function duplicated() {\n  return "first"\n}', newText: '', occurrence: 2 }],
          },
        },
        context: createContext(root),
      })

      const content = fs.readFileSync(path.join(root, 'main.js'), 'utf8')
      expect(targeted?.continuity?.resultText).toContain('Successfully replaced 1 block')
      expect(content.match(/function duplicated/g)).toHaveLength(1)
      expect(content).toContain('function keep()')
    })
  })

  it('returns continuity for editFile missing-file and empty-edit failures', async () => {
    await withTempWorkspace('archetype-coder-edit-failures-', async (root) => {
      const missing = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'missing.md',
            edits: [{ oldText: 'x', newText: 'y' }],
          },
        },
        context: createContext(root),
      })
      expect(missing?.continuity?.resultText).toContain('file does not exist')

      fs.writeFileSync(path.join(root, 'index.md'), '# Index\n', 'utf8')
      const empty = await executeCoderAction({
        action: {
          name: 'editFile',
          params: {
            path: 'index.md',
            edits: [],
          },
        },
        context: createContext(root),
      })
      expect(empty?.continuity?.resultText).toContain('edits[] was empty')
    })
  })

  it('returns continuity for runCommand and sandbox tool results', async () => {
    await withTempWorkspace('archetype-coder-sandbox-', async (root) => {
      const context = createContext(root, {
        sandbox: {
          async runCommand(input) {
            if (input.command[0] === 'sh' && input.command[1] === '-c') {
              fs.writeFileSync(path.join(root, 'index.html'), '<!DOCTYPE html>\n<script>if (!window.ready) window.ready = true</script>\n', 'utf8')
            }
            return {
              ok: true,
              exitCode: 0,
              stdout: `ran ${input.command.length} arg(s)`,
              stderr: '',
              command: input.command,
              settingsPath: '/tmp/settings.json',
              timedOut: false,
            }
          },
          async runTool(name) {
            return {
              ok: name === 'runStart',
              exitCode: name === 'runStart' ? 0 : 1,
              stdout: `${name} stdout`,
              stderr: `${name} stderr`,
              command: [name],
              settingsPath: '/tmp/settings.json',
              timedOut: false,
              ...(name === 'runTests' ? {
                userFacingCommand: 'node --test test.js',
                userFacingNote: 'runTests used a temporary package boundary so Node module type matched the discovered tests.',
              } : {}),
              ...(name === 'runStart' ? { readyMatch: 'ready', origin: 'http://127.0.0.1:4173' } : {}),
            }
          },
        },
      })

      const command = await executeCoderAction({
        action: { name: 'runCommand', params: { command: ['node', '--version'] } },
        context,
      })
      expect(command?.continuity?.resultText).toContain('exit=0')
      expect(command?.continuity?.staleText).toContain('Full output removed')
      expect(command?.sandboxToolCall).toBe(true)

      const longBody = '<!DOCTYPE html>\n<script>if (!window.ready) window.ready = true</script>\n'.repeat(80)
      const longCommand = await executeCoderAction({
        action: { name: 'runCommand', params: { command: ['sh', '-c', `cat <<'EOF' > index.html\n${longBody}EOF`] } },
        context,
      })
      expect(longCommand?.continuity?.resultText).toContain('argv omitted from continuity')
      expect(longCommand?.continuity?.resultText).toContain('Changed file state:')
      expect(longCommand?.continuity?.resultText).toContain('index.html')
      expect(longCommand?.continuity?.staleText).toContain('Changed file state:')
      expect(longCommand?.continuity?.resultText).not.toContain('<!DOCTYPE html>')
      expect(longCommand?.continuity?.resultText).not.toContain('!window.ready')

      const start = await executeCoderAction({
        action: { name: 'runStart', params: {} },
        context,
      })
      expect(start?.continuity?.resultText).toContain('runStart')
      expect(start?.liveOrigin).toBe('http://127.0.0.1:4173')
      expect(start?.continuity?.staleText).toContain('http://127.0.0.1:4173')

      const build = await executeCoderAction({
        action: { name: 'runBuild', params: {} },
        context,
      })
      expect(build?.continuity?.resultText).toContain('exit=1')
      expect(build?.toolExitCode).toBe(1)
      expect(compactCoderActionOutcome(build!)).toContain('runBuild')
      expect(compactCoderActionOutcome(build!)).toContain('exit=1')
      expect(compactCoderActionOutcome(build!)).toContain('runBuild stderr')

      const tests = await executeCoderAction({
        action: { name: 'runTests', params: {} },
        context,
      })
      expect(tests?.continuity?.resultText).toContain('User-facing command: node --test test.js')
      expect(tests?.continuity?.resultText).toContain('User-facing note: runTests used a temporary package boundary')
      expect(tests?.continuity?.staleText).toContain('User-facing command: node --test test.js')
      expect(tests?.continuity?.auditAnchors).toEqual(expect.arrayContaining(['node --test test.js']))
    })
  })

  it('runs mounted runCommand calls in the canonical visible workspace path world', async () => {
    await withTempWorkspace('archetype-coder-runcommand-visible-root-', async (root) => {
      const specRoot = path.join(root, 'spec')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(specRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      fs.writeFileSync(path.join(specRoot, 'brief.md'), '# Brief\n', 'utf8')
      let observedCwd = ''
      let observedExtraReadPaths: string[] = []
      let observedExtraWritePaths: string[] = []

      const context = createContext(artifactRoot, {
        workspaceMounts: [
          { prefix: 'spec', root: specRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot, writable: true },
        ],
        defaultMountPrefix: 'artifact',
        sandbox: {
          async runCommand(input) {
            observedCwd = input.cwd ?? ''
            observedExtraReadPaths = input.extraReadPaths ?? []
            observedExtraWritePaths = input.extraWritePaths ?? []
            fs.writeFileSync(path.join(observedCwd, 'artifact', 'index.html'), '<h1>Visible</h1>\n', 'utf8')
            return {
              ok: true,
              exitCode: 0,
              stdout: 'wrote visible path',
              stderr: '',
              command: input.command,
              settingsPath: '/tmp/settings.json',
              timedOut: false,
            }
          },
          async runTool() {
            return { ok: false, exitCode: 1, stdout: '', stderr: 'unused', command: [], settingsPath: '/tmp/settings.json', timedOut: false }
          },
        },
      })

      const result = await executeCoderAction({
        action: { name: 'runCommand', params: { command: ['sh', '-c', "cat > artifact/index.html <<'EOF'\n<h1>Visible</h1>\nEOF"] } },
        context,
      })

      expect(observedCwd).toContain('.archetype-visible-workspace')
      expect(fs.lstatSync(path.join(observedCwd, 'artifact')).isSymbolicLink()).toBe(true)
      expect(observedExtraReadPaths).toEqual(expect.arrayContaining([observedCwd, specRoot, artifactRoot]))
      expect(observedExtraWritePaths).toEqual([artifactRoot])
      expect(fs.readFileSync(path.join(artifactRoot, 'index.html'), 'utf8')).toBe('<h1>Visible</h1>\n')
      expect(fs.existsSync(path.join(artifactRoot, 'artifact', 'index.html'))).toBe(false)
      expect(result?.continuity?.resultText).toContain('Changed file state:')
      expect(result?.continuity?.resultText).toContain('artifact/index.html')
      expect(result?.continuity?.resultText).not.toContain('artifact/artifact')
    })
  })

  it('runs mounted sandbox preset tools in the canonical visible workspace path world', async () => {
    await withTempWorkspace('archetype-coder-runtool-visible-root-', async (root) => {
      const inputRoot = path.join(root, 'input')
      const artifactRoot = path.join(root, 'artifact')
      fs.mkdirSync(inputRoot, { recursive: true })
      fs.mkdirSync(artifactRoot, { recursive: true })
      let observedCwd = ''
      let observedExtraReadPaths: string[] = []
      let observedExtraWritePaths: string[] = []

      const context = createContext(artifactRoot, {
        workspaceMounts: [
          { prefix: 'input', root: inputRoot, writable: false },
          { prefix: 'artifact', root: artifactRoot, writable: true },
        ],
        defaultMountPrefix: 'artifact',
        sandbox: {
          async runCommand() {
            throw new Error('unused')
          },
          async runTool(name, input) {
            observedCwd = input?.cwd ?? ''
            observedExtraReadPaths = input?.extraReadPaths ?? []
            observedExtraWritePaths = input?.extraWritePaths ?? []
            return {
              ok: true,
              exitCode: 0,
              stdout: `${name} saw visible cwd`,
              stderr: '',
              command: [name],
              settingsPath: '/tmp/settings.json',
              timedOut: false,
            }
          },
        },
      })

      const result = await executeCoderAction({
        action: { name: 'runTests', params: {} },
        context,
      })

      expect(result?.continuity?.resultText).toContain('runTests saw visible cwd')
      expect(observedCwd).toContain('.archetype-visible-workspace')
      expect(fs.lstatSync(path.join(observedCwd, 'artifact')).isSymbolicLink()).toBe(true)
      expect(observedExtraReadPaths).toEqual(expect.arrayContaining([observedCwd, inputRoot, artifactRoot]))
      expect(observedExtraWritePaths).toEqual([artifactRoot])
    })
  })

  it('SrtSandbox preserves shell command bytes for common browser file contents', async () => {
    const srtBinary = path.join(process.cwd(), 'node_modules', '.bin', 'srt')
    if (!fs.existsSync(srtBinary)) return

    await withTempWorkspace('archetype-srt-byte-preservation-', async (root) => {
      const sandbox = new SrtSandbox({
        workspaceRoot: root,
        srtBinary,
        sandboxTempRoot: path.join(root, '.sandbox-tmp'),
        trustedReadPaths: ['/bin/sh', '/bin/bash'],
      })

      const script = [
        "cat <<'EOF' > index.html",
        '<!DOCTYPE html>',
        '<script>',
        'if (!window.ready && window.count !== 2) window.ready = true',
        '</script>',
        "const text = 'single quotes and spaces'",
        'EOF',
      ].join('\n')

      const result = await sandbox.exec({ command: ['sh', '-c', script], timeoutMs: 10_000 })
      expect(result.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(root, 'index.html'), 'utf8')).toBe([
        '<!DOCTYPE html>',
        '<script>',
        'if (!window.ready && window.count !== 2) window.ready = true',
        '</script>',
        "const text = 'single quotes and spaces'",
        '',
      ].join('\n'))

      await sandbox.cleanup()
    })
  }, 20_000)

  it('lets hosts apply mechanical same-turn side effects before the next batch action runs', async () => {
    await withTempWorkspace('archetype-coder-batch-side-effects-', async (root) => {
      let openedPath = ''
      const browser: BrowserHarness = {
        async open(path = '/') {
          openedPath = path
          return { ok: true, url: `http://127.0.0.1:4173${path}`, title: 'Started' }
        },
        async screenshot() {
          const bytes = Buffer.from('png')
          return { ok: true, bytes, base64: bytes.toString('base64') }
        },
        async click() {
          return { ok: true, matched: 'text', detail: 'clicked' }
        },
        async type() {
          return { ok: true, detail: 'typed' }
        },
        async key() {
          return { ok: true, detail: 'pressed' }
        },
        getConsoleEntries() {
          return []
        },
        async close() {},
      }
      const context = createContext(root, {
        browser: null,
        sandbox: {
          async runCommand(input) {
            return { ok: true, exitCode: 0, stdout: '', stderr: '', command: input.command, settingsPath: '/tmp/settings.json', timedOut: false }
          },
          async runTool(name) {
            return {
              ok: true,
              exitCode: 0,
              stdout: 'ready',
              stderr: '',
              command: [name],
              settingsPath: '/tmp/settings.json',
              timedOut: false,
              readyMatch: 'ready',
              origin: 'http://127.0.0.1:4173',
            }
          },
        },
      })

      const results = await executeCoderActions({
        actions: [
          { name: 'runStart', params: {} },
          { name: 'browserOpen', params: { path: '/artifact/index.html' } },
          { name: 'browserScreenshot', params: { label: 'home' } },
        ],
        context,
        onActionResult(execution, mutableContext) {
          if (execution.result?.liveOrigin) mutableContext.browser = browser
        },
      })

      expect(results.map(item => item.result?.ok)).toEqual([true, true, true])
      expect(openedPath).toBe('/artifact/index.html')
      expect(results[2]?.result?.capturedScreenshot).toBe(true)
    })
  })

  it('returns continuity for blocked browser actions and successful browser observations', async () => {
    await withTempWorkspace('archetype-coder-browser-', async (root) => {
      const blockedOpen = await executeCoderAction({
        action: { name: 'browserOpen', params: { path: '/' } },
        context: createContext(root),
      })
      expect(blockedOpen?.continuity?.resultText).toContain('no live server')

      const blockedScreenshot = await executeCoderAction({
        action: { name: 'browserScreenshot', params: { label: 'home' } },
        context: createContext(root),
      })
      expect(blockedScreenshot?.continuity?.resultText).toContain('no browser is currently open')

      let openedPath = ''
      const browser: BrowserHarness = {
        async open(path = '/') {
          openedPath = path
          return { ok: false, url: 'http://127.0.0.1:4173/missing.html', title: 'Missing' }
        },
        async screenshot() {
          const bytes = Buffer.from('png')
          return { ok: true, bytes, base64: bytes.toString('base64') }
        },
        async click() {
          return { ok: true, matched: 'text', detail: 'clicked Start' }
        },
        async type() {
          return { ok: true, detail: 'typed name' }
        },
        async key() {
          return { ok: true, detail: 'pressed Enter' }
        },
        getConsoleEntries() {
          return [{
            type: 'error',
            text: 'Failed to load resource: the server responded with a status of 404 (Not Found)',
            location: { url: 'http://127.0.0.1:4173/missing.css', lineNumber: 12, columnNumber: 4 },
          }]
        },
        async close() {},
      }
      const context = createContext(root, { browser })

      const open = await executeCoderAction({
        action: { name: 'browserOpen', params: { path: '/artifact/missing.html' } },
        context: createContext(root, { browser, defaultMountPrefix: 'artifact' }),
      })
      expect(openedPath).toBe('/missing.html')
      expect(open?.continuity?.resultText).toContain('ok: false')
      expect(open?.continuity?.resultText).toContain('title: Missing')

      await executeCoderAction({
        action: { name: 'browserOpen', params: { path: 'http://127.0.0.1:4173/artifact/index.html' } },
        context: createContext(root, { browser, defaultMountPrefix: 'artifact' }),
      })
      expect(openedPath).toBe('http://127.0.0.1:4173/index.html')

      await executeCoderAction({
        action: { name: 'browserOpen', params: { path: 'artifact/index.html' } },
        context: createContext(root, {
          browser,
          defaultMountPrefix: '',
          browserMountPrefix: 'artifact',
        }),
      })
      expect(openedPath).toBe('/index.html')

      const screenshot = await executeCoderAction({
        action: { name: 'browserScreenshot', params: { label: 'home' } },
        context,
      })
      expect(screenshot?.continuity?.resultTurns).toBe(1)
      expect(screenshot?.continuity?.staleText).toContain('image attachment is no longer in continuity')
      expect(screenshot?.attachments?.[0]?.mimeType).toBe('image/png')

      const click = await executeCoderAction({
        action: { name: 'browserClick', params: { text: 'Start' } },
        context,
      })
      expect(click?.continuity?.resultText).toContain('matched: text')

      const consoleResult = await executeCoderAction({
        action: { name: 'browserConsole', params: {} },
        context,
      })
      expect(consoleResult?.continuity?.resultText).toContain('error: Failed to load resource')
      expect(consoleResult?.continuity?.resultText).toContain('http://127.0.0.1:4173/missing.css')
      expect(consoleResult?.continuity?.resultText).toContain('line 12')
    })
  })

  it('documents runCommand cwd and browserOpen path semantics', () => {
    expect(coderActions.runCommand.description).toContain('same canonical workspace path world shown in FILES')
    expect(coderActions.runCommand.description).toContain('cwd contains visible mount directories')
    expect(coderActions.runCommand.description).toContain('use those exact paths in shell commands too')
    expect(coderActions.runCommand.description).toContain('compact changed-file summary')
    expect(coderActions.runLint.description).toContain("host's fixed ruleset")
    expect(coderActions.runLint.description).toContain('Project ESLint config files do not change this action')
    expect(coderActions.browserOpen.description).toContain('served URL path')
    expect(coderActions.browserOpen.description).toContain('visible file path from FILES')
    expect(coderActions.browserOpen.description).toContain('/src/index.html')
    expect(coderActions.browserOpen.description).toContain('After file changes')
  })

  it('documents finishAttempt as an active work item status claim, not a hidden judge', () => {
    expect(coderActions.finishAttempt.description).toContain('active work item/session')
    expect(coderActions.finishAttempt.description).toContain('honest summary')
    expect(coderActions.finishAttempt.description).toContain('expert self-review')
    expect(coderActions.finishAttempt.description).toContain('active request')
    expect(coderActions.finishAttempt.description).toContain('source context')
    expect(coderActions.finishAttempt.description).toContain('produced work')
    expect(coderActions.finishAttempt.description).toContain('continue working instead of calling this')
    expect(coderActions.finishAttempt.description).toContain('own handoff/status claim')
    expect(coderActions.finishAttempt.description).toContain('runtime records it')
    expect(coderActions.finishAttempt.description).toContain('normal turn flow')
    expect(coderActions.finishAttempt.description).not.toMatch(/\bmust|required|always|never\b/i)
    expect(coderActions.finishAttempt.description).not.toMatch(/\bveto|approve|approval|judge\b/i)
  })

  it('exposes returnToSession as the non-evaluative focus handoff action', () => {
    expect(Object.keys(coderActions)).toContain('returnToSession')
    expect(coderActions.returnToSession.description).toContain('Return from private focus work')
    expect(coderActions.returnToSession.description).toContain('visible session flow')
    expect(coderActions.returnToSession.description).toContain('not a quality check')
    expect(coderActions.returnToSession.schema.safeParse({
      message: 'The spec files are ready in spec/.',
      to: 'builder',
      state: 'ready',
    }).success).toBe(true)
    expect(coderActions.returnToSession.schema.safeParse({
      outcome: 'success',
      summary: 'done',
    }).success).toBe(false)
  })

  it('uses the shared action-continuity helper for next-turn attachments', () => {
    const first = { attachments: [{ type: 'image' as const, mimeType: 'image/png', data: 'first' }] }
    const stale = {
      attachments: [{ type: 'image' as const, mimeType: 'image/png', data: 'stale' }],
      continuity: { resultText: 'stale', resultTurns: 0 },
    }
    const latest = { attachments: [{ type: 'image' as const, mimeType: 'image/png', data: 'latest' }] }

    expect(collectCoderActionAttachmentsForNextTurn([first, stale, latest])).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'latest' },
    ])
  })

  it('preserves result decay metadata when adapting coder results for the turn ledger', () => {
    const outcome = coderActionOutcomeForLedger(
      { name: 'readFile', params: { path: 'input/brief.md' } },
      {
        historyNote: 'Tool result: readFile input/brief.md',
        continuity: {
          resultText: 'readFile input/brief.md\ncontent:\n# Brief',
          resultTurns: 2,
          staleText: '<readFile result for input/brief.md no longer carried>',
        },
      },
    )

    expect(outcome.resultText).toContain('# Brief')
    expect(outcome.resultTurns).toBe(2)
    expect(outcome.staleText).toContain('no longer carried')
  })
})
