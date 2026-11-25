import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALE_FILES = ['locale/zh.json', 'locale/en.json']
const DETAIL_EXTENSION = /\.(md|markdown)$/i
const RELATIVE_SPECIFIERS = [
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]
const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*(<[^>]*>|[^\s)]+)(?:\s+["'][^"']*["'])?\s*\)/g

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
}

const packageJson = readJson('package.json')
const FILE_ENTRIES = Array.isArray(packageJson.files) ? packageJson.files : []

// Files npm always ships regardless of the `files` array.
const ALWAYS_INCLUDED = [
  /^package\.json$/,
  /^readme(\.[^/]*)?$/i,
  /^(license|licence)(\.[^/]*)?$/i,
]

function normalizeEntry(value) {
  return String(value).replace(/^\.\//, '').replace(/\\/g, '/').replace(/^\//, '')
}

function globToRegExp(pattern) {
  let source = ''
  for (const char of pattern) {
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

function isAlwaysIncluded(relativePath) {
  if (ALWAYS_INCLUDED.some(pattern => pattern.test(relativePath))) return true
  return Boolean(packageJson.main) && normalizeEntry(packageJson.main) === relativePath
}

// Minimal npm-packlist semantics: trailing slash means a directory prefix, a bare
// path matches itself or the directory it names, and `*` never crosses a segment.
function isPackaged(relativePath, entries = FILE_ENTRIES) {
  const normalized = normalizeEntry(relativePath)
  if (isAlwaysIncluded(normalized)) return true
  return entries.some(entry => {
    const pattern = normalizeEntry(entry)
    if (!pattern) return false
    if (pattern.endsWith('/')) return normalized.startsWith(pattern)
    if (!/[*?]/.test(pattern)) {
      return normalized === pattern || normalized.startsWith(`${pattern}/`)
    }
    return globToRegExp(pattern).test(normalized)
  })
}

function stripComments(source) {
  let output = ''
  let index = 0
  let quote = null
  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (quote) {
      output += char
      if (char === '\\') {
        output += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = null
      index += 1
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
      output += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) index += 1
      index += 2
      output += ' '
      continue
    }
    output += char
    index += 1
  }
  return output
}

function collectRelativeSpecifiers(source) {
  const specifiers = new Set()
  for (const pattern of RELATIVE_SPECIFIERS) {
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match) {
      const specifier = match[1]
      if (specifier.startsWith('./') || specifier.startsWith('../')) specifiers.add(specifier)
      match = pattern.exec(source)
    }
  }
  return [...specifiers]
}

function resolveRelativeSpecifier(importer, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier))
  const candidates = [base]
  if (!path.posix.extname(base)) {
    candidates.push(`${base}.js`, `${base}.json`, path.posix.join(base, 'index.js'))
  }
  for (const candidate of candidates) {
    const absolute = path.join(ROOT, candidate)
    if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return candidate
  }
  return null
}

// Walks the host-side module graph that DSH imports when it loads the bundle.
function collectHostClosure(entry) {
  const queue = [normalizeEntry(entry)]
  const files = new Set()
  const unresolved = []
  while (queue.length > 0) {
    const relativePath = queue.shift()
    if (files.has(relativePath)) continue
    files.add(relativePath)
    const source = stripComments(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'))
    for (const specifier of collectRelativeSpecifiers(source)) {
      const resolved = resolveRelativeSpecifier(relativePath, specifier)
      if (resolved) queue.push(resolved)
      else unresolved.push({ importer: relativePath, specifier })
    }
  }
  return { files: [...files].sort(), unresolved }
}

function readDetailDocs() {
  return LOCALE_FILES.map(localeFile => ({
    localeFile,
    detail: readJson(localeFile)?.meta?.detail,
  }))
}

function validDetailDocs() {
  return readDetailDocs()
    .map(({ detail }) => detail)
    .filter(detail => typeof detail === 'string' && detail.length > 0)
}

function extractMarkdownImageDestinations(markdown) {
  const destinations = []
  MARKDOWN_IMAGE.lastIndex = 0
  let match = MARKDOWN_IMAGE.exec(markdown)
  while (match) {
    destinations.push(match[1].replace(/^<|>$/g, ''))
    match = MARKDOWN_IMAGE.exec(markdown)
  }
  return destinations
}

function isLocalDestination(destination) {
  if (!destination) return false
  if (destination.startsWith('#') || destination.startsWith('/') || destination.startsWith('//')) return false
  return !/^[a-z][a-z0-9+.-]*:/i.test(destination)
}

// Resolves a Markdown destination against the posix directory of its document.
function resolveDocDestination(docPath, destination) {
  const withoutSuffix = destination.split('#')[0].split('?')[0]
  return path.posix.normalize(path.posix.join(path.posix.dirname(docPath), decodeURIComponent(withoutSuffix)))
}

function stripFencedCodeBlocks(markdown) {
  const kept = []
  let fence = null
  for (const line of markdown.split('\n')) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (match) {
      if (!fence) {
        fence = match[1][0]
        continue
      }
      if (match[1][0] === fence) {
        fence = null
        continue
      }
    }
    if (!fence) kept.push(line)
  }
  return kept.join('\n')
}

test('npm files matcher handles directory, glob, exact and always-included entries', () => {
  const entries = ['index.js', 'locale/*.json', 'src/store/', 'README.en.md']
  assert.equal(isPackaged('index.js', entries), true)
  assert.equal(isPackaged('locale/en.json', entries), true)
  assert.equal(isPackaged('locale/nested/en.json', entries), false)
  assert.equal(isPackaged('src/store/host.js', entries), true)
  assert.equal(isPackaged('src/store/nested/contract.js', entries), true)
  assert.equal(isPackaged('src/client/index.js', entries), false)
  assert.equal(isPackaged('README.en.md', entries), true)
  assert.equal(isPackaged('docs/project.md', entries), false)
  assert.equal(isPackaged('package.json', entries), true)
  assert.equal(isPackaged('README.md', entries), true)
  assert.equal(isPackaged('LICENSE', entries), true)
})

test('host import closure reachable from index.js is fully packaged', () => {
  const closure = collectHostClosure('index.js')
  assert.deepEqual(closure.unresolved, [])
  assert.ok(closure.files.includes('index.js'))
  assert.ok(closure.files.length > 1, 'expected index.js to reach host modules')
  const missing = closure.files.filter(file => !isPackaged(file))
  assert.deepEqual(missing, [], `package.json files does not package host modules: ${missing.join(', ')}`)
})

test('the host modules missing from the broken tarball stay packaged', () => {
  const closure = collectHostClosure('index.js')
  const expected = [
    'index.js',
    'src/store/host.js',
    'src/store/migrate.js',
    'src/store/contract.js',
    'src/domain/workspace.js',
    'src/domain/active-group.js',
  ]
  for (const file of expected) {
    assert.ok(closure.files.includes(file), `${file} is not reachable from index.js`)
    assert.equal(isPackaged(file), true, `${file} is not matched by package.json files`)
  }
})

test('locale meta.detail is a valid, packaged relative Markdown path', () => {
  for (const { localeFile, detail } of readDetailDocs()) {
    assert.equal(typeof detail, 'string', `${localeFile} meta.detail must be a string`)
    assert.ok(detail.length > 0, `${localeFile} meta.detail must not be empty`)
    assert.ok(!detail.includes('\\'), `${localeFile} meta.detail must use posix separators`)
    assert.ok(!detail.startsWith('/'), `${localeFile} meta.detail must be relative`)
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(detail), `${localeFile} meta.detail must not be a URL`)
    const segments = detail.split('/')
    assert.ok(
      segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..'),
      `${localeFile} meta.detail must not contain empty or traversal segments`,
    )
    assert.match(detail, DETAIL_EXTENSION, `${localeFile} meta.detail must point at Markdown`)
    assert.ok(fs.existsSync(path.join(ROOT, detail)), `${localeFile} meta.detail document is missing`)
    assert.equal(isPackaged(detail), true, `${localeFile} meta.detail document is not packaged`)
  }
})

test('detail documents reference only existing, packaged images', () => {
  const referenced = new Set()
  for (const docPath of validDetailDocs()) {
    const markdown = fs.readFileSync(path.join(ROOT, docPath), 'utf8')
    const destinations = extractMarkdownImageDestinations(markdown).filter(isLocalDestination)
    assert.ok(destinations.length > 0, `${docPath} should reference at least one local image`)
    for (const destination of destinations) {
      const target = resolveDocDestination(docPath, destination)
      assert.ok(target.length > 0 && !target.startsWith('..'), `${docPath} image escapes the package root: ${destination}`)
      assert.ok(fs.existsSync(path.join(ROOT, target)), `${docPath} references a missing image: ${destination}`)
      assert.equal(isPackaged(target), true, `${docPath} image is not packaged: ${target}`)
      referenced.add(target)
    }
  }
  assert.equal(referenced.size >= 4, true, `expected all four preview images to be referenced, saw ${[...referenced].join(', ')}`)
})

test('package.json describes the plugin for listings', () => {
  assert.equal(typeof packageJson.description, 'string')
  assert.ok(packageJson.description.trim().length > 0, 'package.json description must not be empty')
  assert.ok(!packageJson.description.includes('\n'), 'package.json description must be a single line')
})

test('detail documents contain no raw HTML outside fenced code blocks', () => {
  for (const docPath of validDetailDocs()) {
    const markdown = fs.readFileSync(path.join(ROOT, docPath), 'utf8')
    const offending = stripFencedCodeBlocks(markdown)
      .split('\n')
      .filter(line => /^\s*</.test(line))
    assert.deepEqual(
      offending,
      [],
      `${docPath} contains raw HTML that the plugin detail renderer drops: ${offending.slice(0, 3).join(' | ')}`,
    )
  }
})
// The README keeps a centered GitHub hero (raw HTML), while the plugin detail
// documents stay pure Markdown because DSH drops HTML nodes. Both must share the
// same body; image targets are canonicalised so their relative paths can differ.
const README_PAIRS = [
  { readme: 'README.md', detail: 'docs/plugin-detail/zh.md' },
  { readme: 'README.en.md', detail: 'docs/plugin-detail/en.md' },
]

function canonicalImageTargets(markdown, docPath) {
  return markdown.replace(MARKDOWN_IMAGE, (match, destination) => {
    const value = destination.replace(/^<|>$/g, '')
    if (!isLocalDestination(value)) return match
    const target = resolveDocDestination(docPath, value)
    return match.replace(destination, target)
  })
}

function bodyAfterHero(markdown, docPath) {
  const index = markdown.search(/^## /m)
  assert.ok(index > 0, docPath + ' should have a level-2 body section after its hero')
  return canonicalImageTargets(markdown.slice(index), docPath).trim()
}

test('README keeps a centered hero with a 96px logo and orange badges', () => {
  for (const { readme } of README_PAIRS) {
    const markdown = fs.readFileSync(path.join(ROOT, readme), 'utf8')
    const hero = markdown.slice(0, markdown.search(/^## /m))
    assert.ok(hero.includes('<p align="center">'), readme + ' hero should be centered')
    assert.ok(/<img [^>]*width="96"/.test(hero), readme + ' hero logo should be 96px wide')
    assert.ok(/<img [^>]*height="96"/.test(hero), readme + ' hero logo should be 96px tall')
    const badges = hero.match(/https:\/\/img\.shields\.io\/[^"\s)]+/g) ?? []
    assert.ok(badges.length >= 3, readme + ' hero should keep its shields badges')
    assert.ok(badges.every(badge => badge.includes('-orange?style=flat-square')), readme + ' badges should use the orange colour')
  }
})

test('plugin detail documents mirror the README body', () => {
  for (const { readme, detail } of README_PAIRS) {
    const readmeMarkdown = fs.readFileSync(path.join(ROOT, readme), 'utf8')
    const detailMarkdown = fs.readFileSync(path.join(ROOT, detail), 'utf8')
    assert.equal(
      bodyAfterHero(detailMarkdown, detail),
      bodyAfterHero(readmeMarkdown, readme),
      detail + ' body drifted from ' + readme,
    )
  }
})

test('plugin detail mirrors use the packaged 96px logo and orange badges', () => {
  for (const { detail } of README_PAIRS) {
    const markdown = fs.readFileSync(path.join(ROOT, detail), 'utf8')
    assert.ok(markdown.includes('](../brand/logo-96.svg)'), detail + ' should use the 96px logo asset')
    assert.ok(markdown.includes('-orange?style=flat-square'), detail + ' should use orange badges')
    assert.equal(isPackaged('docs/brand/logo-96.svg'), true, 'the 96px logo must be packaged')
  }
})
