#!/usr/bin/env node
import fs from 'node:fs'

const version = (process.argv[2] || '').replace(/^v/, '')
if (!version) {
  console.error('usage: extract-release-notes.mjs <version>')
  process.exit(2)
}

const body = fs.readFileSync('CHANGELOG.md', 'utf8')
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const heading = new RegExp('^## \\[' + escaped + '\\] - \\d{4}-\\d{2}-\\d{2}$', 'm')
const match = heading.exec(body)
if (!match) {
  console.error('no CHANGELOG section found for version ' + version)
  process.exit(1)
}

const rest = body.slice(match.index)
const next = /^## \[/m.exec(rest.slice(match[0].length))
const section = next ? rest.slice(0, match[0].length + next.index) : rest
if (!section.includes('Source:')) {
  console.error('CHANGELOG section for ' + version + ' must contain a Source: line')
  process.exit(1)
}

process.stdout.write(section.trimEnd() + '\n')
