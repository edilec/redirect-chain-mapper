import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { INCOMPLETE_RULES, RULE_SEVERITY, buildReport, exitCodeFor, mapTrace } from '../src/index.mjs'

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))

async function scratch() {
  return mkdtemp(join(tmpdir(), 'redirect-chain-mapper-incomplete-'))
}

async function mapBytes(contents, map = {}) {
  const directory = await scratch()
  const path = join(directory, 'trace.json')
  await writeFile(path, contents)
  return mapTrace({ trace: path, ...map })
}

async function mapDocument(document, map = {}) {
  return mapBytes(JSON.stringify(document), map)
}

function rules(report) {
  return report.findings.map((finding) => finding.ruleId)
}

test('a file that is not there is incomplete, never a pass', async () => {
  const directory = await scratch()
  const { report } = await mapTrace({ trace: join(directory, 'absent.json') })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rules(report), ['input-unreadable'])
  assert.equal(report.findings[0].location.file, 'absent.json')
  assert.equal(exitCodeFor(report), 2)
})

test('a directory where a trace was expected is incomplete', async () => {
  const directory = await scratch()
  const { report } = await mapTrace({ trace: directory })
  assert.deepEqual(rules(report), ['input-unreadable'])
  assert.equal(report.status, 'incomplete')
})

test('bytes that are not UTF-8 are refused, and the verdict never comes from the decoded text', async () => {
  // The file holds a literal U+FFFD *and* an undecodable byte. A tool that
  // inferred "not UTF-8" from seeing U+FFFD in decoded text would have to
  // disable its own guard here — which is exactly how undecodable bytes came
  // to be reported as a pass in an earlier tool in this catalogue.
  const replacement = Buffer.from('�', 'utf8')
  const broken = Buffer.concat([
    Buffer.from('{"requests":[{"url":"https://example.com/', 'utf8'),
    replacement,
    Buffer.from([0xff, 0xfe]),
    Buffer.from('","status":200}]}', 'utf8'),
  ])
  const { report } = await mapBytes(broken)
  assert.deepEqual(rules(report), ['input-not-utf8'])
  assert.equal(report.status, 'incomplete')
  assert.equal(exitCodeFor(report), 2)
})

test('a literal U+FFFD in valid UTF-8 is ordinary text, not an encoding failure', async () => {
  const { report } = await mapDocument({
    requests: [{ url: 'https://example.com/a�b', status: 200 }],
  })
  assert.ok(!rules(report).includes('input-not-utf8'))
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('JSON that does not parse is incomplete', async () => {
  const { report } = await mapBytes('{"requests":[')
  assert.deepEqual(rules(report), ['input-invalid-json'])
  assert.equal(report.status, 'incomplete')
})

test('a document that is neither HAR nor trace is incomplete', async () => {
  const { report } = await mapDocument({ har: { entries: [] } })
  assert.deepEqual(rules(report), ['trace-unrecognized'])
  assert.equal(report.status, 'incomplete')
})

test('each declared input bound is enforced and named in the finding it raises', async () => {
  const document = { requests: [{ url: 'https://example.com/a', status: 200 }] }

  const large = await mapDocument(document, { limits: { maxInputBytes: 10 } })
  assert.deepEqual(rules(large.report), ['input-too-large'])
  assert.match(large.report.findings[0].message, /maxInputBytes limit of 10/)
  assert.equal(large.report.status, 'incomplete')

  let nested = { requests: [] }
  for (let depth = 0; depth < 40; depth += 1) nested = { nest: nested }
  const deep = await mapDocument(nested, { limits: { maxJsonDepth: 8 } })
  assert.deepEqual(rules(deep.report), ['input-too-deep'])
  assert.match(deep.report.findings[0].message, /maxJsonDepth limit of 8/)

  const many = await mapDocument(
    {
      requests: [
        { url: 'https://example.com/a', status: 200 },
        { url: 'https://example.com/b', status: 200 },
        { url: 'https://example.com/c', status: 200 },
      ],
    },
    { limits: { maxEntries: 2 } },
  )
  assert.deepEqual(rules(many.report), ['entry-limit-exceeded'])
  assert.match(many.report.findings[0].message, /maxEntries limit of 2/)
  assert.equal(many.report.summary.checked, 0)
  assert.equal(many.report.status, 'incomplete')
})

test('a chain longer than maxChainHops stops at the bound instead of being truncated quietly', async () => {
  const requests = []
  for (let index = 0; index < 5; index += 1) {
    requests.push({ url: `https://example.com/${index}`, status: 301, location: `/${index + 1}` })
  }
  requests.push({ url: 'https://example.com/5', status: 200 })

  const bounded = await mapDocument({ requests }, { limits: { maxChainHops: 3, maxChainLength: 99 } })
  // The walk stops at the bound and the remainder is mapped as its own chain,
  // so the addresses beyond the bound are still reported rather than dropped.
  assert.deepEqual(
    bounded.report.findings.map((finding) => [finding.ruleId, finding.location.pointer]),
    [
      ['chain-mapped', '/chains/0'],
      ['hop-limit-exceeded', '/chains/0'],
      ['chain-mapped', '/chains/1'],
    ],
  )
  assert.match(bounded.report.findings[1].message, /maxChainHops limit of 3/)
  assert.equal(bounded.report.status, 'incomplete')
  assert.equal(bounded.chains.length, 2)
  assert.equal(bounded.chains[0].hops.length, 3)
  assert.equal(bounded.chains[0].destination, null)
  assert.equal(bounded.chains[1].start, 'https://example.com/3')

  const whole = await mapDocument({ requests }, { limits: { maxChainLength: 99 } })
  assert.deepEqual(rules(whole.report), ['chain-mapped'])
  assert.equal(whole.chains[0].destination, 'https://example.com/5')
  assert.equal(whole.report.status, 'pass')
})

test('a capture with nothing to map is incomplete, because green on no evidence is not a result', async () => {
  for (const document of [{ requests: [] }, [], { log: { version: '1.2', entries: [] } }]) {
    const { report } = await mapDocument(document)
    assert.equal(report.summary.checked, 0)
    assert.deepEqual(rules(report), ['trace-empty'], JSON.stringify(document))
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
  }
})

/**
 * The load-bearing cases.
 *
 * Each report below carries no `error` finding at all, so the `incomplete` flag
 * is the *only* thing standing between it and a green run. Deleting the rule
 * from `INCOMPLETE_RULES`, or dropping the flag it sets, turns every one of
 * these into `pass` with exit 0 — which is the defect these assertions exist to
 * catch.
 */
const FLAG_IS_THE_ONLY_GUARD = [
  {
    name: 'a chain whose target the capture never requested',
    file: 'examples/broken/truncated.json',
    expected: ['chain-mapped', 'chain-target-not-captured'],
  },
  {
    name: 'a chain whose last hop has no captured response',
    file: 'examples/broken/capture.har',
    expected: ['chain-mapped', 'chain-response-missing'],
  },
]

for (const scenario of FLAG_IS_THE_ONLY_GUARD) {
  test(`${scenario.name} is incomplete with no error finding to fail on`, async () => {
    const { report } = await mapTrace({ trace: join(projectDirectory, scenario.file) })
    assert.deepEqual(rules(report), scenario.expected)
    assert.equal(report.summary.errors, 0, 'no error severity may be doing the work here')
    assert.ok(report.summary.checked > 0, 'the run must have mapped something')
    assert.equal(report.status, 'incomplete')
    assert.equal(exitCodeFor(report), 2)
    for (const ruleId of scenario.expected) {
      if (RULE_SEVERITY[ruleId] === 'info') continue
      assert.ok(INCOMPLETE_RULES.includes(ruleId), `${ruleId} must mark the run incomplete`)
    }
  })
}

test('a capture that declares itself truncated is incomplete with no error finding', async () => {
  const { report } = await mapDocument({
    captureComplete: false,
    requests: [
      { url: 'https://example.com/a', status: 301, location: '/b' },
      { url: 'https://example.com/b', status: 200 },
    ],
  })
  assert.deepEqual(rules(report), ['capture-declared-incomplete', 'chain-mapped'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
})

test('an unrecognised HAR version is incomplete with no error finding', async () => {
  const { report } = await mapDocument({
    log: {
      version: '2.0',
      entries: [
        {
          request: { method: 'GET', url: 'https://example.org/a' },
          response: { status: 301, headers: [{ name: 'Location', value: '/b' }] },
        },
        { request: { method: 'GET', url: 'https://example.org/b' }, response: { status: 200, headers: [] } },
      ],
    },
  })
  assert.deepEqual(rules(report), ['chain-mapped', 'har-version-unsupported'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
})

test('an unfollowed 3xx is incomplete with no error finding', async () => {
  const { report } = await mapDocument({
    requests: [{ url: 'https://example.com/a', status: 300, location: '/b' }],
  })
  assert.deepEqual(rules(report), ['redirect-status-unusual'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 1)
  assert.equal(report.status, 'incomplete')
})

test('the report envelope refuses a pass with nothing checked, on its own', () => {
  // The second, independent guard. `trace-empty` already forces `incomplete`
  // through the rule list, so without this direct test the status expression's
  // own `checked === 0` clause could be deleted with the whole suite still
  // green — which is exactly the shape of invariant that stops being true.
  const empty = buildReport([], { checked: 0, requests: 0, redirectChains: 0, hops: 0, loops: 0, incompleteChains: 0 }, false)
  assert.equal(empty.status, 'incomplete')
  assert.equal(empty.summary.checked, 0)
  assert.deepEqual(empty.findings, [])
  assert.equal(exitCodeFor(empty), 2)

  const counted = buildReport([], { checked: 1, requests: 1, redirectChains: 0, hops: 1, loops: 0, incompleteChains: 0 }, false)
  assert.equal(counted.status, 'pass')
  assert.equal(exitCodeFor(counted), 0)
})

test('every rule that marks a run incomplete is a rule the table defines', () => {
  for (const ruleId of INCOMPLETE_RULES) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is not in RULE_SEVERITY`)
  }
  assert.deepEqual([...INCOMPLETE_RULES].sort(), [...INCOMPLETE_RULES])
})
