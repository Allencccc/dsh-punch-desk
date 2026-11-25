import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dictionaries } from '../src/locale.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.work'])
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g
const FENCE_RE = /```[\s\S]*?```/g

/** @param {string} dir @returns {string[]} */
function markdownFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...markdownFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
  }
  return files
}

/** @param {string} dir @returns {string[]} */
function javascriptFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...javascriptFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full)
  }
  return files
}

/** GitHub-style heading slug. @param {string} heading */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}_\-\u4e00-\u9fff ]/gu, '')
    .replace(/ /g, '-')
}

/** @param {string} file @returns {Set<string>} */
function anchorsOf(file) {
  const body = fs.readFileSync(file, 'utf8').replace(FENCE_RE, '')
  const anchors = new Set()
  for (const line of body.split('\n')) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line)
    if (heading) anchors.add(slug(heading[1]))
  }
  for (const explicit of body.matchAll(/<a\s+[^>]*id="([^"]+)"/g)) {
    anchors.add(explicit[1].toLowerCase())
  }
  return anchors
}

/**
 * Progress claims are prose, so only objective invariants are asserted here:
 * 1. every relative markdown link resolves and every heading anchor exists;
 * 2. every "current test baseline" mention equals the canonical AGENTS count.
 * Actual delivery status still requires human review (AGENTS §10.1).
 */
test('docs health: relative links/anchors resolve and the test baseline is consistent', () => {
  const files = markdownFiles(ROOT)
  const anchorCache = new Map(files.map(file => [file, anchorsOf(file)]))
  const missingLinks = []
  const badAnchors = []

  for (const file of files) {
    const body = fs.readFileSync(file, 'utf8').replace(FENCE_RE, '')
    for (const match of body.matchAll(LINK_RE)) {
      const destination = match[1]
      if (/^(https?:|mailto:)/.test(destination)) continue
      const [rawPath, rawAnchor] = destination.split('#')
      const target = rawPath === ''
        ? file
        : path.resolve(path.dirname(file), decodeURIComponent(rawPath))
      if (rawPath !== '' && !fs.existsSync(target)) {
        missingLinks.push(`${path.relative(ROOT, file)} -> ${destination}`)
        continue
      }
      if (rawAnchor) {
        const anchor = decodeURIComponent(rawAnchor).toLowerCase()
        if (!anchorCache.get(target)?.has(anchor)) {
          badAnchors.push(`${path.relative(ROOT, file)} -> ${destination}`)
        }
      }
    }
  }

  assert.deepEqual(missingLinks, [], `broken relative links:\n${missingLinks.join('\n')}`)
  assert.deepEqual(badAnchors, [], `broken heading anchors:\n${badAnchors.join('\n')}`)

  // The public snapshot omits AGENTS.md and internal docs; only the private
  // source tree runs the baseline consistency check. Link/anchor/locale checks
  // remain active in both trees.
  const agentsPath = path.join(ROOT, 'AGENTS.md')
  if (fs.existsSync(agentsPath)) {
    const agents = fs.readFileSync(agentsPath, 'utf8')
    const canonical = /npm test\s+# node --test，(\d+) 个用例/.exec(agents)
    assert.ok(canonical, 'AGENTS.md must declare the canonical test count on the npm test line')
    const expected = canonical[1]

    // Only "current baseline" statements are compared; historical transitions
    // (e.g. 240/330/390 -> 383) and per-milestone snapshots are intentionally
    // excluded so the check stays an objective consistency assertion.
    const baselineClaims = [
      { file: 'AGENTS.md', pattern: /已建立 (\d+) 项自动化测试基线/g },
      { file: 'AGENTS.md', pattern: /(\d+) 项全量自动化测试/g },
      { file: 'AGENTS.md', pattern: /npm test` 全绿 \((\d+)\/\d+ passed\)/g },
      { file: 'docs/project.md', pattern: /保持 (\d+) 项全量自动化测试基线/g },
      {
        file: 'docs/superpowers/plans/2026-11-08-punch-desk-v2-refinement-plan.md',
        pattern: /(\d+) 用例全部通过/g,
      },
      {
        file: 'docs/superpowers/specs/2026-11-08-punch-desk-v2-refinement-and-next-steps.md',
        pattern: /自动化测试基线 \*\*(\d+) 项全绿\*\*/g,
      },
    ]
    const mismatches = []
    for (const claim of baselineClaims) {
      const claimPath = path.join(ROOT, claim.file)
      if (!fs.existsSync(claimPath)) continue
      const body = fs.readFileSync(claimPath, 'utf8')
      for (const match of body.matchAll(claim.pattern)) {
        if (match[1] !== expected) {
          mismatches.push(`${claim.file}: says ${match[1]}, canonical ${expected}`)
        }
      }
    }
    assert.deepEqual(mismatches, [], `stale test baselines:\n${mismatches.join('\n')}`)
  }

  // Locale drift guard (P2-2): a document-only check can never notice a t('key')
  // whose key does not exist (e.g. submit.sequentialCostWarning shipped dead for
  // days). Assert zh/en pairing and that every referenced key is defined.
  const dicts = dictionaries()
  const zhKeys = new Set(Object.keys(dicts.zh || {}))
  const enKeys = new Set(Object.keys(dicts.en || {}))
  const unpaired = [
    ...[...zhKeys].filter(key => !enKeys.has(key)).map(key => `zh-only: ${key}`),
    ...[...enKeys].filter(key => !zhKeys.has(key)).map(key => `en-only: ${key}`),
  ]
  assert.deepEqual(unpaired, [], `locale keys must be zh/en paired:\n${unpaired.join('\n')}`)

  const referenced = new Map()
  const tCall = /\bt\(\s*'([^']+)'/g
  for (const file of javascriptFiles(path.join(ROOT, 'src'))) {
    const body = fs.readFileSync(file, 'utf8')
    for (const match of body.matchAll(tCall)) {
      if (!referenced.has(match[1])) referenced.set(match[1], new Set())
      referenced.get(match[1]).add(path.relative(ROOT, file))
    }
  }
  const undefinedKeys = [...referenced.entries()]
    .filter(([key]) => !zhKeys.has(key) || !enKeys.has(key))
    .map(([key, files]) => `${key} <- ${[...files].join(', ')}`)
  assert.deepEqual(undefinedKeys, [], `t() references undefined locale keys:\n${undefinedKeys.join('\n')}`)
})
