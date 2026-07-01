/**
 * CoderAgentSandbox — the "what the host owns" layer.
 *
 * archetype/builder/sandbox.ts gives us a confined-execution primitive
 * (SrtSandbox). This file wraps it with the two preset tools this
 * example's persona needs:
 *
 *   runBuild  → copy workspace files into dist/   (toolchain/static-build.mjs)
 *   runStart  → boot a local static server        (toolchain/static-serve.mjs)
 *
 * Anything generic (argv execution, env allowlist, settings-file
 * writing, SRT invocation) stays in archetype. The mapping from tool
 * name → concrete argv lives here because "what runBuild means" is
 * a product decision, not an SDK one. A different consumer would wrap
 * the same SrtSandbox with different presets (webpack, tsc, pytest…).
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { SrtSandbox } from 'archetype/builder'

const require = createRequire(import.meta.url)

const READY_ORIGIN_PATTERN = /READY\s+(https?:\/\/\S+)/

export class CoderAgentSandbox {
  constructor({ workspaceRoot, distRoot, evidenceRoot, toolchainDir, allowedLoopbackPort = 0 }) {
    this.workspaceRoot = path.resolve(workspaceRoot)
    this.distRoot = path.resolve(distRoot)
    this.evidenceRoot = path.resolve(evidenceRoot)
    this.staticBuildScript = path.join(toolchainDir, 'static-build.mjs')
    this.staticServeScript = path.join(toolchainDir, 'static-serve.mjs')
    this.allowedLoopbackPort = allowedLoopbackPort
    this.nodeBinary = process.execPath

    this.sandbox = new SrtSandbox({
      workspaceRoot: this.workspaceRoot,
      srtBinary: resolveSrtBinary(),
      sandboxTempRoot: path.join(this.workspaceRoot, '.sandbox-tmp'),
      trustedReadPaths: [
        this.nodeBinary,
        path.dirname(this.nodeBinary),
        this.staticBuildScript,
        this.staticServeScript,
        toolchainDir,
      ],
      settingsDir: this.evidenceRoot,
    })
  }

  /**
   * Generic argv execution — required by the CoderSandbox interface so
   * executeCoderAction can forward runCommand calls. Not used by this
   * example's persona (runCommand isn't in its action set), but the
   * method has to exist for the interface to hold.
   */
  async runCommand({ command, timeoutMs }) {
    const argv = command.slice()
    if (argv[0] === 'node') argv[0] = this.nodeBinary
    return this.sandbox.exec({ command: argv, timeoutMs: timeoutMs ?? 120_000 })
  }

  async runTool(name) {
    if (name === 'runBuild') return this.#runBuild()
    if (name === 'runStart') return this.#runStart()
    throw new Error(`CoderAgentSandbox: this example's preset only implements runBuild and runStart — got "${name}".`)
  }

  async #runBuild() {
    return this.sandbox.exec({
      command: [this.nodeBinary, this.staticBuildScript, this.workspaceRoot, this.distRoot],
      timeoutMs: 120_000,
    })
  }

  async #runStart() {
    // runStart terminates any prior server before booting the next one,
    // so a re-build + re-start cycle doesn't leave zombie listeners
    // holding the loopback port.
    await this.cleanup()
    const targetRoot = fs.existsSync(path.join(this.distRoot, 'index.html')) ? this.distRoot : this.workspaceRoot
    const spawned = await this.sandbox.spawn({
      command: [this.nodeBinary, this.staticServeScript, targetRoot, String(this.allowedLoopbackPort)],
      allowLocalBinding: true,
      readyPattern: READY_ORIGIN_PATTERN,
      readyTimeoutMs: 20_000,
    })
    const origin = spawned.readyMatch ?? `http://127.0.0.1:${this.allowedLoopbackPort || 0}`
    return { ...spawned, origin }
  }

  async cleanup() {
    await this.sandbox.cleanup()
  }
}

function resolveSrtBinary() {
  if (process.env.SRT_BINARY) return process.env.SRT_BINARY
  const pkgPath = require.resolve('@anthropic-ai/sandbox-runtime/package.json')
  return path.join(path.dirname(pkgPath), 'dist', 'cli.js')
}
