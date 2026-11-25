#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const tgz = process.argv[2]
if (!tgz) {
  console.error('usage: check-tarball.mjs <tarball.tgz>')
  process.exit(2)
}

const listing = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
const entries = listing
  .split('\n')
  .map(line => line.replace(/^package\//, '').trim())
  .filter(Boolean)

const required = [
  'package.json',
  'LICENSE',
  'README.md',
  'README.en.md',
  'index.js',
  'client.js',
  'cordis.patch.yml',
  'icon.svg',
  'logo.svg',
  'locale/en.json',
  'locale/zh.json',
  'docs/plugin-detail/en.md',
  'docs/plugin-detail/zh.md',
  'docs/brand/logo-96.svg',
  'src/store/host.js',
  'src/domain/entries.js',
]
const missing = required.filter(file => !entries.includes(file))
if (!entries.some(file => file.startsWith('docs/mockup/previews/') && file.endsWith('.png'))) {
  missing.push('docs/mockup/previews/*.png')
}

const forbidden = [
  'AGENTS.md',
  'docs/arch/',
  'docs/project.md',
  'docs/user-cases.md',
  'docs/superpowers/',
  'docs/mockup/punch_desk_mockup',
  'docs/mockup/punch_desk_wireframes.html',
  'scripts/',
  'tests/',
  '.github/',
  'src/client/',
  'dist/',
  'node_modules/',
]
const bad = entries.filter(file => forbidden.some(item => file === item || file.startsWith(item)))

if (missing.length || bad.length) {
  if (missing.length) console.error('tarball is missing required entries:\n' + missing.join('\n'))
  if (bad.length) console.error('tarball contains forbidden entries:\n' + bad.join('\n'))
  process.exit(1)
}

console.log('tarball OK: ' + entries.length + ' entries')
