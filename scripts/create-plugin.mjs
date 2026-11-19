#!/usr/bin/env node
/**
 * Create a plugin directory from `templates/plugin`.
 *
 * Usage:
 *   pnpm run new <name> [--title "Title"] [--description "Sentence-case description."]
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const templateDir = path.join(repoRoot, 'templates', 'plugin')
const pluginsDir = path.join(repoRoot, 'plugins')

const TEXT_EXTENSIONS = new Set(['.json', '.md', '.ts', '.yml', '.yaml', '.svg', '.txt'])

function fail(message) {
  console.error(`create-plugin: ${message}`)
  console.error('')
  console.error(
    'Usage: pnpm run new <name> [--title "Title"] [--description "Sentence-case description."]',
  )
  process.exit(1)
}

function parseArgs(argv) {
  const options = { name: '', title: '', description: '' }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--title' || argument === '--description') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) fail(`${argument} needs a value`)
      options[argument.slice(2)] = value
      index += 1
      continue
    }
    if (argument.startsWith('--')) fail(`unknown option ${argument}`)
    if (options.name) fail(`unexpected argument ${argument}`)
    options.name = argument
  }

  return options
}

function toTitle(name) {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)))
    else files.push(entryPath)
  }
  return files
}

const options = parseArgs(process.argv.slice(2))
const name = options.name

if (!name) fail('missing plugin name')
if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name)) {
  fail(`"${name}" is not a kebab-case name (for example: quick-note)`)
}
if (name === 'template') fail('"template" is reserved')

const target = path.join(pluginsDir, name)
if (existsSync(target)) {
  fail(`plugins/${name} already exists; remove it first if you really want to recreate it`)
}

const title = options.title || toTitle(name)
const description = options.description || 'Adds one Agent tool to DeepSeek Harness.'
const tool = `${name.replaceAll('-', '_')}_greet`

const replacements = {
  __NAME__: name,
  __TITLE__: title,
  __DESCRIPTION__: description,
  __TOOL__: tool,
}

await mkdir(path.dirname(target), { recursive: true })
await cp(templateDir, target, { recursive: true })

for (const file of await collectFiles(target)) {
  if (!TEXT_EXTENSIONS.has(path.extname(file))) continue
  let content = await readFile(file, 'utf8')
  for (const [token, value] of Object.entries(replacements)) {
    content = content.split(token).join(value)
  }
  if (/__[A-Z][A-Z0-9_]*__/.test(content)) {
    fail(`unreplaced placeholder left in ${path.relative(repoRoot, file)}`)
  }
  await writeFile(file, content)
}

console.log(`Created plugins/${name}`)
console.log(`  package: dsh-plugin-${name}`)
console.log(`  title:   ${title}`)
console.log(`  tool:    ${tool}`)
console.log('')
console.log('Next steps:')
console.log('  1. pnpm install')
console.log(`  2. Implement the real capability in plugins/${name}/src/index.ts`)
console.log('  3. Replace icon.svg and write the Chinese locale and docs/DETAIL.md')
console.log('  4. pnpm check')
console.log('  5. Install it from DeepSeek Harness -> Plugins -> Add plugin')
