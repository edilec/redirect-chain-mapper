#!/usr/bin/env node

import { DEFAULT_LIMITS, FORMATS, exitCodeFor, formatReport, mapTrace } from '../src/index.mjs'

const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS)

const HELP = `redirect-chain-mapper

Map the redirect chains in a captured trace: hop counts, loops, scheme changes,
and the chains whose destination the capture never recorded. Nothing is fetched;
every address in the report came out of the file you passed.

Usage:
  redirect-chain-mapper --trace FILE [--root DIR] [--format FORMAT] [--limit NAME=N]... [--json]

Options:
  --trace FILE      Capture to read: a HAR 1.2 export or a JSON trace (required)
  --root DIR        Input root the trace path is resolved inside and may not
                    escape, lexically or through a symbolic link. Use it when
                    the path came from a manifest rather than from you.
  --format FORMAT   ${FORMATS.join(', ')} (default: auto)
  --limit NAME=N    Override a declared limit. Repeatable.
                    Names: ${LIMIT_NAMES.join(', ')}
  --json            Suppress the human summary on stderr
  -h, --help        Show this help

Streams:
  stdout  the JSON report, and nothing else, so it can be piped into a parser
  stderr  the human summary, the chain map, and any diagnostics

Exit codes:
  0  every mapped chain terminated within policy
  1  the check completed and found a failure
  2  invalid configuration (stdout is empty), or an input that could not be
     read, decoded or parsed (stdout carries an "incomplete" report)

A chain whose final hop has no captured response, or whose target the capture
never requested, is reported as incomplete with no destination. This tool does
not guess where a redirect goes.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { trace: null, root: null, format: 'auto', limits: {}, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--trace') options.trace = takeValue('--trace')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--format') options.format = takeValue('--format')
    else if (argument === '--limit') applyLimit(options.limits, takeValue('--limit'))
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.trace === null) throw new Error('--trace is required')
  return options
}

/**
 * Parse one `--limit name=value` pair.
 *
 * The name is checked against the declared set here as well as in the library,
 * so a typo is refused by the CLI rather than accepted and quietly dropped on
 * the way through. A limit that is documented but never wired is the same
 * defect as no limit at all.
 */
function applyLimit(limits, pair) {
  const split = pair.indexOf('=')
  if (split < 1) throw new Error(`--limit expects NAME=VALUE, got "${pair}"`)
  const name = pair.slice(0, split)
  const raw = pair.slice(split + 1)
  if (!LIMIT_NAMES.includes(name)) {
    throw new Error(`Unknown limit "${name}". Known limits: ${LIMIT_NAMES.join(', ')}`)
  }
  if (!/^[0-9]+$/.test(raw)) throw new Error(`Limit "${name}" must be a non-negative integer, got "${raw}"`)
  limits[name] = Number.parseInt(raw, 10)
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let result
  try {
    result = await mapTrace({
      trace: options.trace,
      root: options.root,
      format: options.format,
      limits: options.limits,
    })
  } catch (error) {
    // A configuration problem means the run never had a subject, so stdout
    // stays empty rather than carrying a report about nothing.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`)
  if (!options.json) process.stderr.write(formatReport(result.report, result.chains))
  return exitCodeFor(result.report)
}

process.exitCode = await main(process.argv.slice(2))
