const NODE_TEST_EXTENSIONS = new Set(['.js', '.mjs', '.cjs'])

/**
 * Return true for JavaScript files Node's built-in test runner users
 * commonly expect `runTests` to discover.
 */
export function isNodeTestFilePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  const basename = segments.at(-1) ?? ''
  const ext = extensionOf(basename)
  if (!NODE_TEST_EXTENSIONS.has(ext)) return false

  if (/^test\.(?:js|mjs|cjs)$/.test(basename)) return true
  if (/\.(?:test|spec)\.(?:js|mjs|cjs)$/.test(basename)) return true
  if (/^test[-_.].*\.(?:js|mjs|cjs)$/.test(basename)) return true

  return segments.slice(0, -1).some(segment => segment === 'test' || segment === 'tests')
}

export function filterNodeTestFilePaths(filePaths: readonly string[]): string[] {
  return filePaths.filter(isNodeTestFilePath).sort((a, b) => a.localeCompare(b))
}

export type InferredNodePackageType = 'commonjs' | 'module'

export interface NodeTestSourceFile {
  path: string
  content: string
}

export function inferNodePackageTypeForTests(files: readonly NodeTestSourceFile[]): InferredNodePackageType {
  for (const file of files) {
    const ext = extensionOf(file.path)
    if (ext === '.mjs') return 'module'
    if (ext === '.cjs') continue
    if (ext === '.js' && looksLikeEsModule(file.content)) return 'module'
  }
  return 'commonjs'
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.')
  return dot === -1 ? '' : fileName.slice(dot)
}

function looksLikeEsModule(content: string): boolean {
  return /^\s*import\s.+from\s+['"][^'"]+['"]/mu.test(content)
    || /^\s*import\s*['"][^'"]+['"]/mu.test(content)
    || /^\s*export\s+(?:class|const|default|function|let|var|\{)/mu.test(content)
}
