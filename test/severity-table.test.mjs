import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { RULE_SEVERITY, severityFor } from '../src/index.mjs'
import { LOCATION_RULE } from '../src/trace.mjs'

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. A literal at each of thirty construction sites
 * is exactly the shape that drifts: flipping one security-relevant rule to
 * `warning` turns a refusal into a green build with every test still passing.
 * These tests assert the single table, the documented catalogue and the shipped
 * source all agree.
 */

async function documentedSeverities() {
  const text = await readFile(join(projectDirectory, 'docs/redirect-rules.md'), 'utf8')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalogue matches the severity table exactly, in both directions', async () => {
  const documented = await documentedSeverities()

  assert.ok(Object.keys(documented).length > 25, 'the catalogue table was not found or was not parsed')
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/redirect-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('no rule id is emitted anywhere in src that the table does not define', async () => {
  const names = (await readdir(join(projectDirectory, 'src'))).filter((name) => name.endsWith('.mjs'))
  assert.ok(names.length >= 4, 'the source scan must actually cover the sources')

  const emitted = new Set()
  for (const name of names) {
    const source = await readFile(join(projectDirectory, 'src', name), 'utf8')
    for (const match of source.matchAll(/ruleId:\s*'([a-z0-9-]+)'/g)) emitted.add(match[1])
  }
  // The four Location rules are chosen through a lookup rather than written at
  // a construction site, so the table itself is checked as well.
  for (const ruleId of Object.values(LOCATION_RULE)) emitted.add(ruleId)

  assert.ok(emitted.size >= 25, `only ${emitted.size} rule ids were found in src`)
  for (const ruleId of emitted) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is emitted but missing from RULE_SEVERITY`)
  }
})

test('an unknown rule id throws instead of defaulting to some severity', () => {
  assert.throws(() => severityFor('chain-to-long'), /Unknown ruleId "chain-to-long"/)
  assert.throws(() => severityFor(''), /Unknown ruleId/)
  assert.equal(severityFor('redirect-loop'), 'error')
})

test('the rules that decide a refusal are errors, not warnings', () => {
  // Each of these is the difference between a refusal and a green build.
  // Demoting any one of them would let the run pass with the defect present.
  assert.equal(RULE_SEVERITY['scheme-downgrade'], 'error')
  assert.equal(RULE_SEVERITY['location-unsafe'], 'error')
  assert.equal(RULE_SEVERITY['location-unsupported-scheme'], 'error')
  assert.equal(RULE_SEVERITY['location-ambiguous'], 'error')
  assert.equal(RULE_SEVERITY['redirect-loop'], 'error')
  assert.equal(RULE_SEVERITY['trace-empty'], 'error')
  assert.equal(RULE_SEVERITY['trace-unknown-field'], 'error')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
  assert.deepEqual(Object.keys(RULE_SEVERITY), [...Object.keys(RULE_SEVERITY)].sort())
  assert.ok(Object.isFrozen(RULE_SEVERITY))
})

test('the documented limits table names exactly the limits the tool enforces', async () => {
  const text = await readFile(join(projectDirectory, 'docs/redirect-rules.md'), 'utf8')
  const documented = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*[0-9]+\s*\|/g)].map((row) => row[1])
  const { DEFAULT_LIMITS } = await import('../src/config.mjs')
  assert.deepEqual(documented.sort(), Object.keys(DEFAULT_LIMITS).sort())
})
