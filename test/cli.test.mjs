import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(projectDirectory, 'bin/redirect-chain-mapper.mjs')

/** Run the real entry point and report what a shell would see. */
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

test('--help explains the tool on stderr and leaves stdout clean for a pipe', async () => {
  const result = await runCli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Usage:\s+redirect-chain-mapper --trace FILE/)
  assert.match(result.stderr, /--limit NAME=N/)
  assert.match(result.stderr, /maxChainHops/)
})

test('the clean example exits 0 with a parseable report and nothing else on stdout', async () => {
  const result = await runCli(['--trace', 'examples/clean/trace.json'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'redirect-chain-mapper')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 2)
  assert.match(result.stderr, /redirect-chain-mapper: pass/)
  assert.match(result.stderr, /old-post -> https:\/\/example\.com\/blog\/new-post -> /)

  const quiet = await runCli(['--trace', 'examples/clean/trace.json', '--json'])
  assert.equal(quiet.code, 0)
  assert.equal(quiet.stdout, result.stdout)
  assert.equal(quiet.stderr, '')
})

test('the broken example exits 1 and names every defect it found', async () => {
  const result = await runCli(['--trace', 'examples/broken/trace.json', '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    [
      'chain-mapped',
      'chain-mapped',
      'chain-too-long',
      'scheme-downgrade',
      'chain-mapped',
      'redirect-loop',
      'location-unsupported-scheme',
    ],
  )
})

test('a truncated capture exits 2 with an incomplete report, not a guessed destination', async () => {
  const result = await runCli(['--trace', 'examples/broken/truncated.json', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.incompleteChains, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'chain-target-not-captured'))
  assert.ok(!JSON.stringify(report).includes('"destination"'))
})

test('a HAR whose last hop has no captured response exits 2', async () => {
  const result = await runCli(['--trace', 'examples/broken/capture.har', '--format', 'har', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((finding) => finding.ruleId === 'chain-response-missing'))
})

test('an input that could not be read exits 2 with a report saying which input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'redirect-chain-mapper-cli-'))
  const result = await runCli(['--trace', join(directory, 'absent.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((finding) => [finding.ruleId, finding.location.file]),
    [['input-unreadable', 'absent.json']],
  )
})

test('a configuration mistake exits 2 with an empty stdout and the message on stderr', async () => {
  const cases = [
    { argv: ['--trace', 'examples/clean/trace.json', '--wat'], message: /Unknown option "--wat"/ },
    { argv: ['--json'], message: /--trace is required/ },
    { argv: ['--trace'], message: /--trace requires a value/ },
    { argv: ['--trace', 'examples/clean/trace.json', '--format', 'json'], message: /Unknown format "json"/ },
    {
      argv: ['--trace', 'examples/clean/trace.json', '--limit', 'maxChainLenght=2'],
      message: /Unknown limit "maxChainLenght"/,
    },
    {
      argv: ['--trace', 'examples/clean/trace.json', '--limit', 'maxChainLength=two'],
      message: /must be a non-negative integer/,
    },
    { argv: ['--trace', 'examples/clean/trace.json', '--limit', 'maxChainLength'], message: /NAME=VALUE/ },
  ]
  for (const scenario of cases) {
    const result = await runCli(scenario.argv)
    assert.equal(result.code, 2, scenario.argv.join(' '))
    assert.equal(result.stdout, '', `${scenario.argv.join(' ')} wrote to stdout`)
    assert.match(result.stderr, scenario.message)
  }
})

test('every declared limit is wired through the CLI and changes the outcome', async () => {
  // A limit accepted by the parser and then dropped on the way to the library
  // is the same defect as no limit at all, so each one is exercised through the
  // real command line rather than through the API.
  const clean = ['--trace', 'examples/clean/trace.json', '--json']

  const policy = await runCli([...clean, '--limit', 'maxChainLength=1'])
  assert.equal(policy.code, 1)
  assert.match(JSON.parse(policy.stdout).findings.at(-1).ruleId, /chain-too-long/)

  const entries = await runCli([...clean, '--limit', 'maxEntries=2'])
  assert.equal(entries.code, 2)
  assert.equal(JSON.parse(entries.stdout).findings[0].ruleId, 'entry-limit-exceeded')

  const bytes = await runCli([...clean, '--limit', 'maxInputBytes=64'])
  assert.equal(bytes.code, 2)
  assert.equal(JSON.parse(bytes.stdout).findings[0].ruleId, 'input-too-large')

  const depth = await runCli([...clean, '--limit', 'maxJsonDepth=2'])
  assert.equal(depth.code, 2)
  assert.equal(JSON.parse(depth.stdout).findings[0].ruleId, 'input-too-deep')

  const hops = await runCli([...clean, '--limit', 'maxChainHops=2', '--limit', 'maxChainLength=9'])
  assert.equal(hops.code, 2)
  assert.ok(
    JSON.parse(hops.stdout).findings.some((finding) => finding.ruleId === 'hop-limit-exceeded'),
    'maxChainHops did not reach the walker',
  )

  // And the same run without any override is green, so the assertions above
  // are about the limits and not about the fixture.
  const untouched = await runCli(clean)
  assert.equal(untouched.code, 0)
})

test('--format pins the reader, and a mismatch is reported rather than guessed around', async () => {
  const result = await runCli(['--trace', 'examples/clean/trace.json', '--format', 'har', '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['trace-unrecognized'],
  )
  assert.match(report.findings[0].message, /--format har/)
})

test('two runs over the same capture write byte-identical stdout', async () => {
  const first = await runCli(['--trace', 'examples/broken/trace.json', '--json'])
  const second = await runCli(['--trace', 'examples/broken/trace.json', '--json'])
  assert.equal(first.stdout, second.stdout)
  assert.equal(first.code, second.code)
  assert.ok(JSON.parse(first.stdout).findings.length >= 5, 'the determinism check must cover a real report')
})
