#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = process.cwd()
const manifestPath = path.join(ROOT, '.github', 'public-files.txt')
if (!fs.existsSync(manifestPath)) {
  console.error('missing .github/public-files.txt; generate it with scripts/internal/export-public.sh')
  process.exit(1)
}

const manifest = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean).sort()
const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort()
const missing = manifest.filter(file => !tracked.includes(file))
const extra = tracked.filter(file => !manifest.includes(file))
if (missing.length || extra.length) {
  if (missing.length) console.error('manifest lists missing files:\n' + missing.join('\n'))
  if (extra.length) console.error('tracked files missing from manifest:\n' + extra.join('\n'))
  process.exit(1)
}

const forbidden = [
  'AGENTS.md',
  'docs/arch/',
  'docs/project.md',
  'docs/user-cases.md',
  'docs/superpowers/',
  'docs/mockup/punch_desk_mockup',
  'docs/mockup/punch_desk_wireframes.html',
  'scripts/gui-smoke.mjs',
  'scripts/link-profile.mjs',
  'scripts/purge-localstorage-leveldb.sh',
  'scripts/recover-legacy-localstorage.mjs',
  'scripts/release.sh',
  'scripts/release-upload.mjs',
  'scripts/internal/',
]
const badPaths = tracked.filter(file => forbidden.some(item => file === item || file.startsWith(item)))
if (badPaths.length) {
  console.error('forbidden private paths in public tree:\n' + badPaths.join('\n'))
  process.exit(1)
}

const textExtensions = new Set(['.md', '.json', '.js', '.mjs', '.yml', '.yaml', '.sh', '.html', '.css', '.txt', '.patch'])
const patterns = [
  ['personal absolute path', /\/Users\/allen/],
  ['GitHub token', /ghp_[A-Za-z0-9]{36}/],
  ['fine-grained GitHub token', /github_pat_[A-Za-z0-9_]{20,}/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['private key block', /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/],
]
const leaks = []
for (const file of tracked) {
  if (file.startsWith('tests/')) continue
  if (!textExtensions.has(path.extname(file))) continue
  const body = fs.readFileSync(path.join(ROOT, file), 'utf8')
  for (const [label, pattern] of patterns) {
    if (pattern.test(body)) leaks.push(file + ': ' + label)
  }
}
if (leaks.length) {
  console.error('sensitive content found in public tree:\n' + leaks.join('\n'))
  process.exit(1)
}

console.log('public tree OK: ' + tracked.length + ' files match the manifest')
