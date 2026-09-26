import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parseFailureDetail } from '../src/index.mjs'

/**
 * A trace is a capture of someone else's traffic -- headers, cookies, query
 * strings -- and the trace that fails to parse is the one nothing has
 * validated. V8 hands its content straight back inside the error message:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` is the whole
 * trace when it is short, and a window around the offence when it is not.
 * `input-invalid-json` interpolated that message, so the raw capture reached
 * the JSON report on stdout, which is the stream a consumer stores.
 *
 * `excerpt` does not fix it: it flattens control characters and cuts from the
 * END, while the quoted span sits at the FRONT, well inside the limit.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(projectDirectory, 'bin/redirect-chain-mapper.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

function runCli(argv) {
  return new Promise((fulfil) => {
    execFile(
      process.execPath,
      [cli, ...argv],
      { cwd: projectDirectory, encoding: 'utf8' },
      (error, stdout, stderr) => {
        fulfil({ code: error === null ? 0 : error.code, stdout, stderr })
      },
    )
  })
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'redirect-chain-mapper-leak-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a trace that is nothing but a credential is not echoed by either report', async (t) => {
  const directory = await workspace(t)
  const trace = join(directory, 'trace.json')
  await writeFile(trace, CANARY)

  for (const extra of [[], ['--json']]) {
    const result = await runCli(['--trace', trace, ...extra])
    assert.equal(result.code, 2, 'a trace that could not be read makes the run incomplete')
    assertNoCanary(result.stdout, `stdout for ${JSON.stringify(extra)}`)
    assertNoCanary(result.stderr, `stderr for ${JSON.stringify(extra)}`)
  }
})

test('a credential inside an unparseable trace is not echoed either', async (t) => {
  const directory = await workspace(t)
  const trace = join(directory, 'trace.json')
  // V8 quotes a WINDOW around the offence, not only the head of the file, so a
  // secret in the middle of a broken capture leaks just as readily.
  await writeFile(trace, `{"log": {"version": "1.2"}, "authorization": ${CANARY}}`)

  const result = await runCli(['--trace', trace, '--json'])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('a trace that merely CONTAINS "at position" does not smuggle itself through', async (t) => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the file supplied that phrase itself.
  const directory = await workspace(t)
  const trace = join(directory, 'trace.json')
  await writeFile(trace, `${CANARY} at position 9 (line 1 column 10)`)

  const result = await runCli(['--trace', trace, '--json'])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
  assert.match(result.stdout, /unexpected token 'A'/)
})

test('the finding still says what was wrong and where', async (t) => {
  const directory = await workspace(t)
  const trace = join(directory, 'trace.json')
  await writeFile(trace, '{"schemaVersion": "1" "entries": []}')

  const result = await runCli(['--trace', trace, '--json'])
  const report = JSON.parse(result.stdout)
  const finding = report.findings.find((entry) => entry.ruleId === 'input-invalid-json')
  assert.ok(finding !== undefined, 'the trace was refused as invalid JSON')
  // A diagnostic that says nothing is a different defect: position, line and
  // column are V8's useful half and none of them is captured content.
  assert.match(finding.message, /at position 22 \(line 1 column 23\)/)
  assert.equal(finding.location.pointer, '/input')
})

test('parseFailureDetail keeps the position and drops the quoted trace', () => {
  const cases = [
    [CANARY, "unexpected token 'A'"],
    [`{"a": ${CANARY}}`, "unexpected token 'A'"],
    ['ssn 123-45-6789', "unexpected token 's'"],
    [
      '{"a": 1 "b": 2}',
      "Expected ',' or '}' after property value in JSON at position 8 (line 1 column 9)",
    ],
    [`{"a":"${CANARY}`, 'Unterminated string in JSON at position 26 (line 1 column 27)'],
    ['', 'Unexpected end of JSON input'],
  ]
  for (const [text, expected] of cases) {
    try {
      JSON.parse(text)
      assert.fail(`${JSON.stringify(text)} was supposed to be unparseable`)
    } catch (error) {
      assert.equal(parseFailureDetail(error), expected)
    }
  }
})

test('a non-Error, and an error with no message, still produce a usable detail', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail({}), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('')), 'it could not be parsed as JSON')
})
