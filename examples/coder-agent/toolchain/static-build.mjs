import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const workspaceRoot = process.argv[2]
const outputRoot = process.argv[3]

if (!workspaceRoot || !outputRoot) {
  console.error('Usage: node static-build.mjs <workspaceRoot> <outputRoot>')
  process.exit(1)
}

const sourceRoot = path.resolve(workspaceRoot)
const distRoot = path.resolve(outputRoot)

const indexPath = path.join(sourceRoot, 'index.html')
if (!fs.existsSync(indexPath)) {
  console.error('Build failed: index.html is required in the workspace root.')
  process.exit(1)
}

fs.rmSync(distRoot, { recursive: true, force: true })
fs.mkdirSync(distRoot, { recursive: true })

const copied = []
copyTree(sourceRoot, distRoot, '')
console.log(`Static build complete. ${copied.length} file(s) copied to ${distRoot}.`)

function copyTree(sourceBase, outputBase, relative) {
  const current = relative ? path.join(sourceBase, relative) : sourceBase
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    if (shouldSkip(entry.name, entry.isDirectory())) continue
    const entryRel = relative ? path.join(relative, entry.name) : entry.name
    const src = path.join(sourceBase, entryRel)
    const out = path.join(outputBase, entryRel)
    if (entry.isDirectory()) {
      fs.mkdirSync(out, { recursive: true })
      copyTree(sourceBase, outputBase, entryRel)
      continue
    }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.copyFileSync(src, out)
    copied.push(out)
  }
}

function shouldSkip(name, isDirectory) {
  if (isDirectory) return ['dist', 'node_modules', '.git', '.tmp'].includes(name)
  return ['.DS_Store', 'package-lock.json'].includes(name)
}
