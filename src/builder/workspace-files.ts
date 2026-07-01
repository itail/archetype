import fs from 'node:fs'
import path from 'node:path'

export interface WorkspaceFileEntry {
  path: string
  bytes: number
  lines: number | null
  /** Present when entries come from workspace mounts. */
  writable?: boolean
}

export interface WorkspaceMount {
  /**
   * Virtual path prefix exposed to the model, e.g. "spec" or "artifact".
   * Use "" only for a legacy single-root workspace.
   */
  prefix: string
  /** Absolute filesystem root backing this virtual prefix. */
  root: string
  /** Defaults to true. Set false for spec/reference mounts. */
  writable?: boolean
  /** Compact factual purpose of this mount, e.g. "implementation artifact". */
  purpose?: string
}

export interface ListWorkspaceFileEntriesOptions {
  ignoreHidden?: boolean
  ignoreDirs?: readonly string[]
  maxEntries?: number
}

export interface RenderWorkspaceMountFileTreeOptions extends ListWorkspaceFileEntriesOptions {
  /**
   * Deprecated: mounted workspaces expose one canonical visible path per file.
   * Kept only so older callers do not fail type-checks; rendering does not
   * create a second "default" alias.
   */
  defaultMountPrefix?: string
}

export interface RenderWorkspaceMountFileContentsOptions {
  maxBytesPerFile?: number
}

export function listWorkspaceFileEntries(
  workspaceRoot: string,
  options: ListWorkspaceFileEntriesOptions = {},
): WorkspaceFileEntry[] {
  const ignoreHidden = options.ignoreHidden ?? true
  const ignoreDirs = new Set(options.ignoreDirs ?? ['node_modules', 'dist'])
  const maxEntries = options.maxEntries ?? 500
  const entries: WorkspaceFileEntry[] = []

  const walk = (dir: string, prefix: string) => {
    if (entries.length >= maxEntries) return
    let items: fs.Dirent[] = []
    try {
      items = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    items.sort((left, right) => left.name.localeCompare(right.name))
    for (const item of items) {
      if (entries.length >= maxEntries) break
      if (ignoreHidden && item.name.startsWith('.')) continue
      if (ignoreDirs.has(item.name)) continue
      const full = path.join(dir, item.name)
      const relPath = prefix ? `${prefix}/${item.name}` : item.name
      if (item.isDirectory()) {
        walk(full, relPath)
        continue
      }
      const stat = fs.statSync(full)
      entries.push({
        path: relPath,
        bytes: stat.size,
        lines: countTextLines(full),
      })
    }
  }

  walk(workspaceRoot, '')
  return entries
}

export function renderWorkspaceFileEntries(entries: readonly WorkspaceFileEntry[]): string[] {
  if (entries.length === 0) return ['(empty)']
  return entries.map(entry => {
    const linePart = entry.lines == null ? 'binary/unknown lines' : `${entry.lines} lines`
    const accessPart = typeof entry.writable === 'boolean'
      ? `, ${entry.writable ? 'writable' : 'read-only'}`
      : ''
    return `${entry.path} — ${linePart}, ${entry.bytes} bytes${accessPart}`
  })
}

export function renderWorkspaceMountFileTree(
  mounts: readonly WorkspaceMount[],
  options: RenderWorkspaceMountFileTreeOptions = {},
): string[] {
  const normalized = normalizeWorkspaceMounts(mounts)
  if (normalized.length === 0) return ['(empty)']
  const lines: string[] = []

  for (const mount of normalized) {
    const entries = listWorkspaceFileEntries(mount.root, options)
    const label = mount.prefix ? `${mount.prefix}/` : './'
    const access = mount.writable === false ? 'read-only' : 'writable'
    const purposeNote = mount.purpose?.trim() ? `, ${mount.purpose.trim()}` : ''
    const emptyNote = entries.length === 0 ? ', empty' : ''
    lines.push(`${label} — ${access}${purposeNote}${emptyNote}`)
    if (entries.length > 0) {
      const visibleEntries = entries.map(entry => ({
        ...entry,
        path: mount.prefix ? `${mount.prefix}/${entry.path}` : entry.path,
      }))
      lines.push(...renderWorkspaceFileEntries(visibleEntries).map(entry => `  ${entry}`))
    }
  }

  return lines
}

export function renderWorkspaceMountFileContents(
  mounts: readonly WorkspaceMount[],
  visiblePaths: readonly string[],
  options: RenderWorkspaceMountFileContentsOptions = {},
): string {
  const maxBytesPerFile = options.maxBytesPerFile ?? 8_000
  const sections: string[] = []

  for (const visiblePath of visiblePaths) {
    let resolved: ResolvedWorkspaceMountPath
    try {
      resolved = resolveWorkspaceMountPath({ mounts, requestPath: visiblePath })
    } catch {
      continue
    }

    let stat: fs.Stats
    try {
      stat = fs.statSync(resolved.absolutePath)
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    const lines = countTextLines(resolved.absolutePath)
    if (lines == null) {
      sections.push(`## ${resolved.visiblePath}\n(binary file, ${stat.size} bytes; use readFile only if this file has a text representation)`)
      continue
    }

    if (stat.size > maxBytesPerFile) {
      sections.push(`## ${resolved.visiblePath}\n${lines} lines, ${stat.size} bytes; content not inlined because it exceeds ${maxBytesPerFile} bytes. Use readFile if exact contents are needed.`)
      continue
    }

    const content = fs.readFileSync(resolved.absolutePath, 'utf8')
    sections.push([
      `## ${resolved.visiblePath}`,
      `${lines} lines, ${stat.size} bytes`,
      '```text',
      content.replace(/\s+$/u, ''),
      '```',
    ].join('\n'))
  }

  return sections.join('\n\n')
}

export interface ResolvedWorkspaceMountPath {
  mount: WorkspaceMount
  /** Absolute path on disk. */
  absolutePath: string
  /** Path relative to the selected mount root. */
  relativePath: string
  /** Path as it should appear in prompts and action outcomes. */
  visiblePath: string
}

export function normalizeWorkspaceMounts(mounts: readonly WorkspaceMount[]): WorkspaceMount[] {
  const seen = new Set<string>()
  return mounts.map(mount => {
    const prefix = normalizeMountPrefix(mount.prefix)
    if (seen.has(prefix)) throw new Error(`Duplicate workspace mount prefix: ${prefix}`)
    seen.add(prefix)
    return {
      ...mount,
      prefix,
      root: path.resolve(mount.root),
      writable: mount.writable ?? true,
    }
  })
}

export function listWorkspaceMountFileEntries(
  mounts: readonly WorkspaceMount[],
  options: ListWorkspaceFileEntriesOptions = {},
): WorkspaceFileEntry[] {
  const normalized = normalizeWorkspaceMounts(mounts)
  return normalized.flatMap(mount =>
    listWorkspaceFileEntries(mount.root, options).map(entry => ({
      ...entry,
      path: mount.prefix ? `${mount.prefix}/${entry.path}` : entry.path,
      writable: mount.writable !== false,
    })),
  )
}

export function resolveWorkspaceMountPath(input: {
  mounts: readonly WorkspaceMount[]
  requestPath: string
  /**
   * Deprecated. Mounted workspaces now use canonical visible paths only.
   * A prefixed path such as artifact/index.html resolves to artifact; an
   * unprefixed path resolves only when a mount with prefix "" exists.
   */
  defaultMountPrefix?: string
}): ResolvedWorkspaceMountPath {
  const mounts = normalizeWorkspaceMounts(input.mounts)
  if (mounts.length === 0) throw new Error('No workspace mounts configured')
  const requestPath = normalizeRequestPath(input.requestPath)
  const explicitMount = mounts
    .filter(mount => mount.prefix.length > 0)
    .sort((left, right) => right.prefix.length - left.prefix.length)
    .find(mount => requestPath === mount.prefix || requestPath.startsWith(`${mount.prefix}/`))

  const rootMount = mounts.find(item => item.prefix.length === 0)
  const mount = explicitMount ?? rootMount
  if (!mount) {
    const visibleRoots = mounts.map(item => item.prefix ? `${item.prefix}/` : './').join(', ')
    throw new Error(`Path "${requestPath}" is not a canonical visible workspace path. Use a visible path from FILES exactly as shown, including its mount prefix (${visibleRoots}).`)
  }
  const relativePath = explicitMount
    ? requestPath.slice(explicitMount.prefix.length).replace(/^\/+/u, '')
    : requestPath
  const absolutePath = resolveInsideRoot(mount.root, relativePath)
  return {
    mount,
    absolutePath,
    relativePath,
    visiblePath: mount.prefix ? `${mount.prefix}/${relativePath}` : relativePath,
  }
}

export function isWorkspaceMountPathWritable(resolved: ResolvedWorkspaceMountPath): boolean {
  return resolved.mount.writable !== false
}

function normalizeMountPrefix(prefix: string) {
  return prefix.replace(/^\/+|\/+$/gu, '')
}

function normalizeRequestPath(requestPath: string) {
  const normalized = requestPath.replace(/^\.\/+/u, '').replace(/^\/+/u, '')
  return normalized === '.' ? '' : normalized
}

function resolveInsideRoot(root: string, relativePath: string): string {
  const resolved = path.resolve(root, relativePath)
  const relative = path.relative(root, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved
  }
  throw new Error(`Refusing to access outside workspace: ${relativePath}. Use a visible path from FILES, such as input/file.md or artifact/file.js; do not use ../ to cross mounts.`)
}

function countTextLines(filePath: string): number | null {
  const buffer = fs.readFileSync(filePath)
  if (buffer.subarray(0, 512).includes(0)) return null
  const text = buffer.toString('utf8')
  return text.length === 0 ? 0 : text.split(/\r?\n/u).length
}
