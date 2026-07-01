/**
 * Sandbox — the low-level confined-execution primitive every coder-
 * persona builder needs.
 *
 * Contract:
 * — `exec`   one-shot command, awaits completion, returns result.
 * — `spawn`  long-running command with ready-pattern detection
 *            (for local HTTP servers, watchers, etc.).
 * — `cleanup` terminate any still-running children.
 *
 * What belongs here (the archetype layer):
 * — `Sandbox` interface
 * — `SrtSandbox` default impl wrapping `@anthropic-ai/sandbox-runtime`
 *   (binary path is passed in — archetype does not resolve it)
 * — `buildSandboxConfig` + `createAllowlistedEnv` helpers so host
 *   apps can compose per-preset configurations.
 *
 * What does NOT belong here:
 * — Benchmark-specific presets (workspace-build, local-start, etc.)
 *   — those encode product decisions about what each tool should do.
 * — Trusted-toolchain resolution (node/npm/eslint binary paths) — the
 *   host app owns which binaries are trusted.
 * — Evidence file writing, telemetry, metric emission — orchestration
 *   layer, not runtime layer.
 *
 * Node-only: uses `node:child_process` + `node:fs`. Consumers that only
 * need browser-safe archetype features (personas, actions, memory)
 * should not reach for this module.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/**
 * Shape of the SRT settings file.
 *
 * Defined inline instead of imported from `@anthropic-ai/sandbox-runtime`
 * so archetype does not take a hard dep on that package. The host app
 * still installs SRT to provide the binary at runtime; we just don't
 * need its type. If SRT expands the schema, extend this type or pass
 * additions via `extraConfig`.
 */
export interface SandboxRuntimeConfig {
  network: {
    allowedDomains: string[]
    deniedDomains: string[]
    allowUnixSockets: string[]
    allowLocalBinding: boolean
  }
  filesystem: {
    denyRead: string[]
    allowRead: string[]
    allowWrite: string[]
    denyWrite: string[]
  }
}

export interface SandboxExecResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  /** The full argv that was invoked, including `srt --settings <path>` prefix. */
  command: string[]
  /** Absolute path to the per-call SRT settings file. Useful for debugging. */
  settingsPath: string
  timedOut: boolean
}

export interface SandboxSpawnResult extends SandboxExecResult {
  /** The captured ready match (group 1 of readyPattern, or full match), if any. */
  readyMatch: string | null
}

export interface SandboxCallOptions {
  /** Command argv. First entry is the binary (inside the sandbox). */
  command: string[]
  /** Optional command working directory. Defaults to workspaceRoot. */
  cwd?: string
  /** Hard timeout for the whole call. Default 120_000ms. */
  timeoutMs?: number
  /** Outbound network allowlist (e.g. `['registry.npmjs.org']`). Default empty. */
  allowedNetworkDomains?: string[]
  /** Whether to permit binding to 127.0.0.1 (for local HTTP servers). Default false. */
  allowLocalBinding?: boolean
  /** Extra read paths beyond the constructor's trustedReadPaths. */
  extraReadPaths?: string[]
  /** Extra write paths beyond workspaceRoot + sandboxTempRoot. */
  extraWritePaths?: string[]
}

export interface SandboxSpawnOptions extends SandboxCallOptions {
  /**
   * Regex applied to stdout as it streams. First match resolves the call
   * with `readyMatch = match[1] ?? match[0]`. If never matched, the spawn
   * resolves when the child exits (failure) or at `readyTimeoutMs`.
   */
  readyPattern?: RegExp
  /** Max time to wait for readyPattern before killing. Default 20_000ms. */
  readyTimeoutMs?: number
}

export interface Sandbox {
  readonly workspaceRoot: string
  exec(options: SandboxCallOptions): Promise<SandboxExecResult>
  spawn(options: SandboxSpawnOptions): Promise<SandboxSpawnResult>
  cleanup(): Promise<void>
}

export interface SrtSandboxOptions {
  workspaceRoot: string
  /**
   * Absolute path to the `srt` binary. Host app resolves this (typically
   * `<host>/node_modules/.bin/srt`). Archetype does not search for it.
   */
  srtBinary: string
  /**
   * Writable temp directory the sandbox owns (for settings files, npm
   * configs, etc.). Defaults to `<workspaceRoot>/.sandbox-tmp`.
   */
  sandboxTempRoot?: string
  /**
   * Read paths allowed into every call — trusted binaries, trusted
   * scripts the persona is allowed to invoke. Added to the per-call
   * `extraReadPaths` on every exec/spawn.
   */
  trustedReadPaths?: string[]
  /** Extra env keys to block on top of archetype's defaults. */
  extraBlockedEnvKeys?: Iterable<string>
  /**
   * Directory to drop SRT settings files for auditing. Defaults to
   * `sandboxTempRoot`. Host apps that want evidence in a separate
   * location can point this at their evidence root.
   */
  settingsDir?: string
}

/**
 * Default list of environment variables the sandbox never forwards to
 * child processes. Prevents credential leakage + shell-history pollution.
 */
export const DEFAULT_BLOCKED_ENV_KEYS: ReadonlySet<string> = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'GOOGLE_API_KEY',
  'SSH_AUTH_SOCK',
  'HISTFILE',
  'HISTFILESIZE',
  'HISTSIZE',
])

export class SrtSandbox implements Sandbox {
  readonly workspaceRoot: string
  private readonly srtBinary: string
  private readonly sandboxTempRoot: string
  private readonly trustedReadPaths: string[]
  private readonly blockedEnvKeys: Set<string>
  private readonly settingsDir: string
  private readonly activeChildren = new Set<ChildProcess>()

  constructor(options: SrtSandboxOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot)
    this.srtBinary = options.srtBinary
    this.sandboxTempRoot = path.resolve(
      options.sandboxTempRoot ?? path.join(this.workspaceRoot, '.sandbox-tmp'),
    )
    this.trustedReadPaths = options.trustedReadPaths ?? []
    this.blockedEnvKeys = new Set(DEFAULT_BLOCKED_ENV_KEYS)
    for (const key of options.extraBlockedEnvKeys ?? []) this.blockedEnvKeys.add(key)
    this.settingsDir = path.resolve(options.settingsDir ?? this.sandboxTempRoot)
    fs.mkdirSync(this.sandboxTempRoot, { recursive: true })
    fs.mkdirSync(this.settingsDir, { recursive: true })
  }

  async exec(options: SandboxCallOptions): Promise<SandboxExecResult> {
    const { args, settingsPath, env, fullCommand, cwd } = this.prepareCall(options)
    return execFileAsync(
      this.srtBinary,
      args,
      {
        cwd,
        env: env as NodeJS.ProcessEnv,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 1024 * 1024,
      },
    ).then(
      value => ({
        ok: true,
        exitCode: 0,
        stdout: value.stdout,
        stderr: value.stderr,
        command: fullCommand,
        settingsPath,
        timedOut: false,
      }),
      error => ({
        ok: false,
        exitCode: typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : 1,
        stdout: (error as { stdout?: string }).stdout ?? '',
        stderr: (error as { stderr?: string }).stderr ?? String(error),
        command: fullCommand,
        settingsPath,
        timedOut: (error as { killed?: boolean }).killed === true,
      }),
    )
  }

  async spawn(options: SandboxSpawnOptions): Promise<SandboxSpawnResult> {
    const { args, settingsPath, env, fullCommand, cwd } = this.prepareCall(options)
    const child = spawn(
      this.srtBinary,
      args,
      {
        cwd,
        env: env as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )

    // Track for cleanup: stays in the set until the child actually exits
    // (whether by ready→background-running, or by error, or by SIGTERM
    // from cleanup()). The exit handler is the only place that removes.
    this.activeChildren.add(child)
    child.on('exit', () => {
      this.activeChildren.delete(child)
    })

    let stdout = ''
    let stderr = ''
    let readyMatch: string | null = null
    let resolved = false

    return new Promise<SandboxSpawnResult>((resolve) => {
      const finalize = (result: SandboxSpawnResult) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      const timeout = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM')
        finalize({
          ok: false,
          exitCode: 124,
          stdout,
          stderr: `${stderr}\nSpawn did not reach ready state before timeout.`.trim(),
          command: fullCommand,
          settingsPath,
          timedOut: true,
          readyMatch,
        })
      }, options.readyTimeoutMs ?? options.timeoutMs ?? 20_000)

      child.stdout?.on('data', chunk => {
        stdout += chunk.toString()
        if (options.readyPattern && !readyMatch) {
          const m = stdout.match(options.readyPattern)
          if (m) {
            readyMatch = m[1] ?? m[0]
            clearTimeout(timeout)
            // Child stays running in the background. Caller is expected
            // to call cleanup() when done (or call spawn() again for a
            // different long-running process, which also triggers the
            // caller's own cleanup).
            finalize({
              ok: true,
              exitCode: 0,
              stdout,
              stderr,
              command: fullCommand,
              settingsPath,
              timedOut: false,
              readyMatch,
            })
          }
        }
      })
      child.stderr?.on('data', chunk => {
        stderr += chunk.toString()
      })
      child.on('exit', code => {
        if (readyMatch) return
        clearTimeout(timeout)
        finalize({
          ok: false,
          exitCode: code ?? 1,
          stdout,
          stderr,
          command: fullCommand,
          settingsPath,
          timedOut: false,
          readyMatch,
        })
      })
    })
  }

  async cleanup() {
    for (const child of this.activeChildren) {
      if (!child.killed) child.kill('SIGTERM')
    }
    this.activeChildren.clear()
  }

  private prepareCall(options: SandboxCallOptions): {
    args: string[]
    settingsPath: string
    env: Record<string, string>
    fullCommand: string[]
    cwd: string
  } {
    const cwd = path.resolve(options.cwd ?? this.workspaceRoot)
    const config = buildSandboxConfig({
      workspaceRoot: this.workspaceRoot,
      sandboxTempRoot: this.sandboxTempRoot,
      trustedReadPaths: this.trustedReadPaths,
      extraReadPaths: options.extraReadPaths,
      extraWritePaths: options.extraWritePaths,
      allowedNetworkDomains: options.allowedNetworkDomains,
      allowLocalBinding: options.allowLocalBinding ?? false,
    })
    const settingsPath = path.join(
      this.settingsDir,
      `srt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
    )
    fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2))
    const env = createAllowlistedEnv(this.sandboxTempRoot, this.blockedEnvKeys)
    const command = this.materializeInlineCommand(options.command)
    const commandString = shellQuoteCommand(command)
    const args = ['--settings', settingsPath, '-c', commandString]
    const fullCommand = [this.srtBinary, ...args]
    return { args, settingsPath, env, fullCommand, cwd }
  }

  private materializeInlineCommand(command: readonly string[]): string[] {
    const [binary, mode, script, ...rest] = command
    if (!binary || !mode || typeof script !== 'string') return [...command]

    const base = path.basename(binary)
    if ((base === 'sh' || base === 'bash' || binary.endsWith('/sh') || binary.endsWith('/bash')) && mode === '-c') {
      const scriptPath = this.writeInlineScript(script, 'sh')
      return [binary, scriptPath, ...rest]
    }

    if ((mode === '-e' || mode === '--eval') && (base === 'node' || binary.endsWith('/node'))) {
      const scriptPath = this.writeInlineScript(script, 'cjs')
      return [binary, scriptPath, ...rest]
    }

    return [...command]
  }

  private writeInlineScript(content: string, extension: 'sh' | 'cjs') {
    const filePath = path.join(
      this.sandboxTempRoot,
      `inline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`,
    )
    fs.writeFileSync(filePath, content, 'utf8')
    return filePath
  }
}

function shellQuoteCommand(argv: readonly string[]): string {
  return argv.map(shellQuoteArg).join(' ')
}

function shellQuoteArg(value: string): string {
  if (value.length === 0) return "''"
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Build an SRT settings object from the knobs archetype exposes. Host
 * apps can call this directly if they want to assemble settings without
 * going through `SrtSandbox` (tests, one-off invocations).
 *
 * Default deny-read list covers sensitive host paths (home dir, /tmp,
 * kernel mounts). Allow-read is workspace + sandbox temp + caller-
 * supplied trusted paths + per-call extras.
 */
export function buildSandboxConfig(input: {
  workspaceRoot: string
  sandboxTempRoot: string
  trustedReadPaths?: string[]
  extraReadPaths?: string[]
  extraWritePaths?: string[]
  allowedNetworkDomains?: string[]
  allowLocalBinding?: boolean
}): SandboxRuntimeConfig {
  const denyRead = [os.homedir(), '/tmp', '/private/tmp', '/proc', '/sys', '/dev']
  const allowRead = [
    input.workspaceRoot,
    input.sandboxTempRoot,
    ...(input.trustedReadPaths ?? []),
    ...(input.extraReadPaths ?? []),
  ]
  const allowWrite = [
    input.workspaceRoot,
    input.sandboxTempRoot,
    ...(input.extraWritePaths ?? []),
  ]
  return {
    network: {
      allowedDomains: input.allowedNetworkDomains ?? [],
      deniedDomains: [],
      allowUnixSockets: [],
      allowLocalBinding: input.allowLocalBinding ?? false,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite: [],
    },
  }
}

/**
 * Build a minimal allowlisted child-process env. Copies only
 * PATH/HOME/LANG/LC_ALL/TERM from the parent, redirects TMPDIR/TMP/TEMP
 * to the sandbox temp root, and blocks everything in `blockedKeys`.
 */
export function createAllowlistedEnv(
  tmpDir: string,
  blockedKeys: ReadonlySet<string> = DEFAULT_BLOCKED_ENV_KEYS,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM']) {
    const value = process.env[key]
    if (value && !blockedKeys.has(key)) env[key] = value
  }
  env.TMPDIR = tmpDir
  env.TMP = tmpDir
  env.TEMP = tmpDir
  return env
}
