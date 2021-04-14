import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { ConfigError, exitCodeFor, mapTrace } from '../src/index.mjs'

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Write a capture into a fresh directory and map it. */
async function mapDocument(document, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'redirect-chain-mapper-'))
  const name = options.name ?? 'trace.json'
  await writeFile(join(directory, name), typeof document === 'string' ? document : JSON.stringify(document))
  return mapTrace({ trace: join(directory, name), ...options.map })
}

/** Every `[ruleId, pointer]` pair in report order. */
function shape(report) {
  return report.findings.map((finding) => [finding.ruleId, finding.location.pointer])
}

function rules(report) {
  return report.findings.map((finding) => finding.ruleId)
}

test('a relative redirect chain is mapped to its captured destination', async () => {
  const { report, chains } = await mapTrace({ trace: join(projectDirectory, 'examples/clean/trace.json') })

  assert.equal(report.status, 'pass')
  assert.deepEqual(report.summary, {
    checked: 2,
    errors: 0,
    warnings: 0,
    requests: 4,
    redirectChains: 1,
    hops: 4,
    loops: 0,
    incompleteChains: 0,
  })
  assert.deepEqual(chains[0].sequence, [
    'https://example.com/blog/old-post',
    'https://example.com/blog/new-post',
    'https://example.com/blog/post',
  ])
  assert.equal(chains[0].outcome, 'terminal')
  assert.equal(chains[0].destination, 'https://example.com/blog/post')
  assert.equal(chains[0].redirects, 2)
  // The second hop's Location was the bare word "post"; resolving it against
  // the request URL is the whole acceptance case.
  assert.equal(chains[0].hops[1].location, 'post')
  assert.equal(chains[0].hops[1].locationRelative, true)
  assert.equal(chains[0].hops[1].target, 'https://example.com/blog/post')
  assert.deepEqual(shape(report), [['chain-mapped', '/chains/0']])
})

test('a cycle terminates and is reported as a loop with no destination', async () => {
  const { report, chains } = await mapDocument({
    requests: [
      { url: 'https://example.com/a', status: 302, location: '/b' },
      { url: 'https://example.com/b', status: 307, location: '/c' },
      { url: 'https://example.com/c', status: 308, location: 'a' },
    ],
  })

  const loop = chains[0]
  assert.equal(loop.outcome, 'loop')
  assert.equal(loop.destination, null)
  assert.equal(loop.loopBackTo, 'https://example.com/a')
  assert.deepEqual(loop.sequence, [
    'https://example.com/a',
    'https://example.com/b',
    'https://example.com/c',
    'https://example.com/a',
  ])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.loops, 1)
  assert.deepEqual(rules(report), ['chain-mapped', 'redirect-loop'])
})

test('a self-redirect is a loop of one hop, not a terminated chain', async () => {
  const { report, chains } = await mapDocument({
    requests: [{ url: 'https://example.com/self', status: 302, location: '/self' }],
  })
  assert.equal(chains[0].outcome, 'loop')
  assert.equal(chains[0].destination, null)
  assert.equal(report.summary.loops, 1)
  assert.equal(report.status, 'fail')
})

test('an https to http hop is reported as a downgrade, an upgrade only as mixed schemes', async () => {
  const down = await mapDocument({
    requests: [
      { url: 'https://example.com/a', status: 301, location: 'http://example.com/b' },
      { url: 'http://example.com/b', status: 200 },
    ],
  })
  assert.deepEqual(rules(down.report), ['chain-mapped', 'scheme-downgrade'])
  assert.equal(down.report.status, 'fail')

  const up = await mapDocument({
    requests: [
      { url: 'http://example.com/a', status: 301, location: 'https://example.com/b' },
      { url: 'https://example.com/b', status: 200 },
    ],
  })
  assert.deepEqual(rules(up.report), ['chain-mapped', 'mixed-scheme'])
  assert.equal(up.report.status, 'pass')
})

test('a chain longer than the maxChainLength policy fails, and the policy is honoured', async () => {
  const document = {
    requests: [
      { url: 'https://example.com/1', status: 301, location: '/2' },
      { url: 'https://example.com/2', status: 301, location: '/3' },
      { url: 'https://example.com/3', status: 200 },
    ],
  }
  const within = await mapDocument(document)
  assert.equal(within.report.status, 'pass')
  assert.deepEqual(rules(within.report), ['chain-mapped'])

  const tightened = await mapDocument(document, { map: { limits: { maxChainLength: 1 } } })
  assert.equal(tightened.report.status, 'fail')
  assert.deepEqual(rules(tightened.report), ['chain-mapped', 'chain-too-long'])
  assert.match(tightened.report.findings[1].message, /above the maxChainLength policy of 1/)

  const relaxed = await mapDocument(document, { map: { limits: { maxChainLength: 0 } } })
  assert.deepEqual(rules(relaxed.report), ['chain-mapped', 'chain-too-long'])
})

test('a HAR 1.2 export is read, and its redirectURL fills in for a missing header', async () => {
  const { report, chains } = await mapDocument({
    log: {
      version: '1.2',
      entries: [
        {
          request: { method: 'GET', url: 'https://example.org/one' },
          response: { status: 302, redirectURL: 'https://example.org/two', headers: [] },
        },
        {
          request: { method: 'GET', url: 'https://example.org/two' },
          response: { status: 200, redirectURL: '', headers: [] },
        },
      ],
    },
  })
  assert.equal(report.status, 'pass')
  assert.deepEqual(shape(report), [
    ['chain-mapped', '/chains/0'],
    ['location-from-redirect-url', '/log/entries/0/redirectURL'],
  ])
  assert.equal(chains[0].destination, 'https://example.org/two')
})

test('a HAR whose header and redirectURL disagree says which one was believed', async () => {
  const { report, chains } = await mapDocument({
    log: {
      version: '1.2',
      entries: [
        {
          request: { method: 'GET', url: 'https://example.org/one' },
          response: {
            status: 302,
            redirectURL: 'https://example.org/elsewhere',
            headers: [{ name: 'location', value: '/two' }],
          },
        },
        { request: { method: 'GET', url: 'https://example.org/two' }, response: { status: 200, headers: [] } },
      ],
    },
  })
  assert.deepEqual(rules(report), ['chain-mapped', 'location-inconsistent'])
  assert.equal(chains[0].destination, 'https://example.org/two')
  assert.equal(report.status, 'pass')
  // A capture that contradicts itself is worth the reader's attention even
  // though the chain still resolved, so it is counted as a warning and not
  // filed away as information.
  assert.equal(report.findings[1].severity, 'warning')
  assert.equal(report.summary.warnings, 1)
})

test('two different Location values for one response refuse to pick a destination', async () => {
  const { report, chains } = await mapDocument({
    requests: [
      {
        url: 'https://example.com/a',
        status: 302,
        headers: [
          { name: 'Location', value: '/b' },
          { name: 'location', value: '/c' },
        ],
      },
    ],
  })
  assert.deepEqual(rules(report), ['chain-mapped', 'location-ambiguous'])
  assert.equal(chains[0].destination, null)
  assert.equal(chains[0].outcome, 'location-unusable')
  assert.equal(report.status, 'fail')
})

test('a Location that cannot be used is an error, not an invented destination', async () => {
  // A redirect the capture recorded and whose target cannot be worked out is
  // *captured evidence of a defect*, so it fails. None of these three rules is
  // in INCOMPLETE_RULES, which makes their `error` severity the only thing
  // between a broken redirect and exit 0 — demote one and this run turns green
  // with the defect still in the capture.
  const cases = [
    {
      name: 'no Location value at all',
      request: { url: 'https://example.com/a', status: 301, headers: [] },
      ruleId: 'location-missing',
    },
    {
      name: 'an empty Location, which is not resolved back to the request URL',
      request: { url: 'https://example.com/a', status: 301, location: '' },
      ruleId: 'location-empty',
    },
    {
      name: 'a Location that does not resolve against the request URL',
      request: { url: 'https://example.com/a', status: 301, location: 'http://' },
      ruleId: 'location-invalid',
    },
  ]

  for (const scenario of cases) {
    const { report, chains } = await mapDocument({ requests: [scenario.request] })
    assert.deepEqual(rules(report), ['chain-mapped', scenario.ruleId], scenario.name)
    assert.equal(report.findings[1].severity, 'error', scenario.name)
    assert.equal(report.summary.errors, 1, scenario.name)
    assert.equal(report.status, 'fail', scenario.name)
    assert.equal(exitCodeFor(report), 1, scenario.name)
    assert.equal(chains[0].outcome, 'location-unusable', scenario.name)
    assert.equal(chains[0].destination, null, scenario.name)
  }
})

test('a 3xx this tool does not follow stops the chain and says so', async () => {
  const { report, chains } = await mapDocument({
    requests: [{ url: 'https://example.com/a', status: 300, location: '/b' }],
  })
  assert.deepEqual(rules(report), ['redirect-status-unusual'])
  assert.equal(chains[0].outcome, 'unfollowed')
  assert.equal(chains[0].destination, null)
  assert.equal(report.status, 'incomplete')
})

test('requests with no redirect at all are mapped and reported as such', async () => {
  const { report } = await mapDocument({
    requests: [
      { url: 'https://example.com/a', status: 200 },
      { url: 'https://example.com/b', status: 404 },
    ],
  })
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.equal(report.summary.redirectChains, 0)
  assert.deepEqual(shape(report), [['no-redirects', '']])
})

test('a bare array of requests is accepted, and --format can be pinned', async () => {
  const bare = await mapDocument([
    { url: 'https://example.com/a', status: 301, location: '/b' },
    { url: 'https://example.com/b', status: 200 },
  ])
  assert.equal(bare.report.status, 'pass')
  assert.equal(bare.chains[0].destination, 'https://example.com/b')

  const pinned = await mapDocument({ log: { version: '1.2', entries: [] } }, { map: { format: 'trace' } })
  assert.deepEqual(rules(pinned.report), ['trace-unrecognized'])
  assert.equal(pinned.report.status, 'incomplete')
})

test('an unknown field in the trace shape is refused rather than silently ignored', async () => {
  const top = await mapDocument({
    requets: [],
    requests: [{ url: 'https://example.com/a', status: 200 }],
  })
  assert.deepEqual(shape(top.report), [
    ['no-redirects', ''],
    ['trace-unknown-field', '/requets'],
  ])
  assert.equal(top.report.status, 'incomplete')

  const inner = await mapDocument({
    requests: [{ url: 'https://example.com/a', staus: 301, location: '/b' }],
  })
  assert.deepEqual(shape(inner.report), [
    ['request-not-captured', '/chains/0'],
    ['trace-unknown-field', '/requests/0/staus'],
  ])
})

test('an entry with no usable identity is reported and dropped, never guessed at', async () => {
  const { report, chains } = await mapDocument({
    requests: [
      { url: 'not a url', status: 200 },
      { url: 'https://example.com/ok', status: 200 },
      { url: 'https://example.com/bad', status: 'moved' },
    ],
  })
  assert.deepEqual(shape(report), [
    ['no-redirects', ''],
    ['entry-invalid', '/requests/0/url'],
    ['entry-invalid', '/requests/2'],
  ])
  assert.equal(chains.length, 1)
  assert.equal(chains[0].start, 'https://example.com/ok')
  assert.equal(report.status, 'incomplete')
})

test('a URL requested twice is one node, which is what lets a cycle close', async () => {
  const { report, chains } = await mapDocument({
    requests: [
      { url: 'https://example.com/a', status: 302, location: '/b' },
      { url: 'https://example.com/b', status: 302, location: '/a' },
      { url: 'https://example.com/a', status: 302, location: '/b' },
    ],
  })
  assert.equal(chains.length, 1)
  assert.equal(chains[0].outcome, 'loop')
  assert.equal(report.summary.requests, 3)
  assert.equal(report.summary.hops, 2)
})

test('mapTrace refuses an unknown limit name and an unknown format', async () => {
  await assert.rejects(
    () => mapTrace({ trace: join(projectDirectory, 'examples/clean/trace.json'), limits: { maxChainLenght: 2 } }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.match(error.message, /Unknown limit "maxChainLenght"/)
      return true
    },
  )
  await assert.rejects(
    () => mapTrace({ trace: join(projectDirectory, 'examples/clean/trace.json'), format: 'hars' }),
    { name: 'ConfigError' },
  )
  await assert.rejects(
    () => mapTrace({ trace: join(projectDirectory, 'examples/clean/trace.json'), limits: { maxEntries: 0 } }),
    { name: 'ConfigError' },
  )
})

test('findings are ordered by file, pointer and rule, not by the order they were found', async () => {
  const { report } = await mapTrace({ trace: join(projectDirectory, 'examples/broken/trace.json') })
  // The chain that fails is mapped second, and its three findings are raised
  // mapped-then-too-long-then-downgrade; the sorted order below is a different
  // sequence, across four distinct pointers, so reversing any key changes it.
  assert.deepEqual(shape(report), [
    ['chain-mapped', '/chains/0'],
    ['chain-mapped', '/chains/1'],
    ['chain-too-long', '/chains/1'],
    ['scheme-downgrade', '/chains/1'],
    ['chain-mapped', '/chains/2'],
    ['redirect-loop', '/chains/2'],
    ['location-unsupported-scheme', '/requests/7/location'],
  ])
  assert.equal(report.status, 'fail')
  assert.deepEqual(report.summary, {
    checked: 3,
    errors: 4,
    warnings: 0,
    requests: 8,
    redirectChains: 3,
    hops: 8,
    loops: 1,
    incompleteChains: 2,
  })
})

test('two findings on one chain sort by rule id, not by the order they were raised', async () => {
  // The walker raises the loop before the length policy; the report must carry
  // them the other way round. Without a chain whose emission order differs from
  // its sorted order, the rule-id key could be deleted with the suite green.
  const { report } = await mapDocument({
    requests: [
      { url: 'https://example.com/a', status: 302, location: '/b' },
      { url: 'https://example.com/b', status: 302, location: '/c' },
      { url: 'https://example.com/c', status: 302, location: '/d' },
      { url: 'https://example.com/d', status: 302, location: '/a' },
    ],
  })
  assert.deepEqual(shape(report), [
    ['chain-mapped', '/chains/0'],
    ['chain-too-long', '/chains/0'],
    ['redirect-loop', '/chains/0'],
  ])
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.loops, 1)
})

test('mapping the same capture twice produces byte-identical JSON', async () => {
  const first = await mapTrace({ trace: join(projectDirectory, 'examples/broken/trace.json') })
  const second = await mapTrace({ trace: join(projectDirectory, 'examples/broken/trace.json') })
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report))
  assert.ok(first.report.findings.length >= 5, 'the determinism check must run over a non-trivial report')
})

test('evidence is bounded and carries no control characters', async () => {
  const long = 'x'.repeat(900)
  const { report } = await mapDocument({
    requests: [
      { url: `https://example.com/${long}`, status: 301, location: `/${long}b` },
      { url: `https://example.com/${long}b`, status: 200 },
    ],
  })
  const evidence = report.findings[0].evidence
  assert.ok(evidence.length <= 303, `evidence was ${evidence.length} characters`)
  assert.ok(evidence.endsWith('...'))
  for (const character of evidence) {
    assert.ok(character.codePointAt(0) >= 0x20, 'evidence must hold no control character')
  }
})
