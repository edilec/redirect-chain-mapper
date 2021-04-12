/**
 * redirect-chain-mapper
 *
 * Read a captured trace — a HAR export or a small JSON trace — and draw the
 * redirect chains it actually contains: where each chain starts, every hop it
 * takes, how many hops that is, whether it closes into a loop, whether it
 * changes scheme, and where it ends.
 *
 * The tool never makes a request. Every address in the report came out of the
 * capture, and the one thing it refuses to do is invent the end of a chain: a
 * chain whose last hop has no captured response, or whose target was never
 * requested, is reported as `incomplete` with no destination, because "I do not
 * know where this goes" and "this goes to X" are different answers and only one
 * of them is true.
 */

import { ConfigError, resolveInputPath, validateLimits } from './config.mjs'
import { byCodeUnit, schemeOf } from './normalize.mjs'
import { FORMATS, extractHops, readTraceDocument } from './trace.mjs'

export { ConfigError, DEFAULT_LIMITS, validateLimits } from './config.mjs'
export { byCodeUnit, normalizeUrl, resolveLocation, REDIRECT_STATUSES } from './normalize.mjs'
export { FORMATS, detectFormat } from './trace.mjs'

export const TOOL_ID = 'redirect-chain-mapper'
export const REPORT_SCHEMA_VERSION = '1'

/** Longest evidence excerpt written into a finding. */
export const EVIDENCE_LIMIT = 300

/**
 * The authoritative rule severity table.
 *
 * Severity is the entire difference between a run that fails and one that
 * passes. Left as a literal at thirty construction sites it drifts silently:
 * one security-relevant rule quietly demoted to `warning` turns a refusal into
 * a green build with every test still passing. So every finding in this tool
 * takes its severity from this table and nowhere else, an unknown rule id
 * throws rather than defaulting, and `docs/redirect-rules.md` is asserted
 * against the table in both directions so code and catalogue cannot part ways.
 */
export const RULE_SEVERITY = Object.freeze({
  'capture-declared-incomplete': 'warning',
  'chain-mapped': 'info',
  'chain-response-missing': 'warning',
  'chain-target-not-captured': 'warning',
  'chain-too-long': 'error',
  'entry-invalid': 'error',
  'entry-limit-exceeded': 'error',
  'har-version-unsupported': 'warning',
  'hop-limit-exceeded': 'error',
  'input-invalid-json': 'error',
  'input-not-utf8': 'error',
  'input-too-deep': 'error',
  'input-too-large': 'error',
  'input-unreadable': 'error',
  'location-ambiguous': 'error',
  'location-empty': 'error',
  'location-from-redirect-url': 'info',
  'location-inconsistent': 'warning',
  'location-invalid': 'error',
  'location-missing': 'error',
  'location-unsafe': 'error',
  'location-unsupported-scheme': 'error',
  'mixed-scheme': 'info',
  'no-redirects': 'info',
  'redirect-loop': 'error',
  'redirect-status-unusual': 'warning',
  'request-not-captured': 'warning',
  'scheme-downgrade': 'error',
  'trace-empty': 'error',
  'trace-unknown-field': 'error',
  'trace-unrecognized': 'error',
})

/**
 * Rules that mean evidence was missing, truncated or deliberately not followed.
 *
 * Any one of them makes the run `incomplete`, which is not interchangeable with
 * `pass`. Six of them carry a severity below `error`, so for those the flag is
 * the *only* thing standing between an unknown answer and a green one — each
 * has a test that fails if it stops being listed here.
 *
 * `request-not-captured` and `chain-response-missing` are the same evidential
 * situation — a hop that was requested and whose response the capture does not
 * hold — and differ only by whether a redirect preceded it. Neither can be a
 * pass: an uncaptured response is absent evidence, not evidence of absence.
 */
export const INCOMPLETE_RULES = Object.freeze([
  'capture-declared-incomplete',
  'chain-response-missing',
  'chain-target-not-captured',
  'entry-invalid',
  'entry-limit-exceeded',
  'har-version-unsupported',
  'hop-limit-exceeded',
  'input-invalid-json',
  'input-not-utf8',
  'input-too-deep',
  'input-too-large',
  'input-unreadable',
  'redirect-status-unusual',
  'request-not-captured',
  'trace-empty',
  'trace-unknown-field',
  'trace-unrecognized',
])

/** Severity for a rule id. An unknown id is a programming error, not a default. */
export function severityFor(ruleId) {
  if (!Object.hasOwn(RULE_SEVERITY, ruleId)) {
    throw new Error(`Unknown ruleId "${ruleId}": every finding must take its severity from RULE_SEVERITY`)
  }
  return RULE_SEVERITY[ruleId]
}

/** A bounded, single-line excerpt. Captured content is data, never an instruction. */
export function excerpt(value) {
  let flattened = ''
  for (const character of String(value)) {
    const code = character.codePointAt(0)
    flattened += code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : character
  }
  flattened = flattened.replace(/ {2,}/g, ' ').trim()
  return flattened.length <= EVIDENCE_LIMIT ? flattened : `${flattened.slice(0, EVIDENCE_LIMIT)}...`
}

/**
 * A collector that stamps every finding with its severity from the one table
 * and with the order it was raised, so ties in the sort key resolve the same
 * way on every run without relying on the sort being stable.
 */
function collector(file) {
  const findings = []
  const emit = (raw) => {
    const finding = {
      ruleId: raw.ruleId,
      severity: severityFor(raw.ruleId),
      message: raw.message,
      location: raw.pointer === undefined ? { file } : { file, pointer: raw.pointer },
    }
    if (raw.evidence !== undefined) finding.evidence = excerpt(raw.evidence)
    if (raw.suggestion !== undefined) finding.suggestion = raw.suggestion
    findings.push({ finding, sequence: findings.length })
    return finding
  }
  return { findings, emit }
}

/**
 * Findings are ordered by `(location.file, location.pointer, ruleId)`, compared
 * as text by UTF-16 code unit, with the order they were raised breaking any
 * remaining tie. Pointer segments are text, so `/chains/10` precedes
 * `/chains/2`; that is stated rather than papered over, because a sort that
 * depends on locale or on hash order is how two machines come to disagree about
 * the same capture.
 */
function sortFindings(entries) {
  return [...entries]
    .sort((left, right) => {
      const a = left.finding
      const b = right.finding
      return (
        byCodeUnit(a.location.file ?? '', b.location.file ?? '') ||
        byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '') ||
        byCodeUnit(a.ruleId, b.ruleId) ||
        byCodeUnit(String(left.sequence).padStart(8, '0'), String(right.sequence).padStart(8, '0'))
      )
    })
    .map((entry) => entry.finding)
}

/**
 * Assemble the report envelope.
 *
 * This is the only place in the tool that decides a status, so there is exactly
 * one path to audit. `checked === 0` cannot be a pass: a run that mapped no
 * chain saw no evidence, and green on no evidence is the defect this guard
 * exists to make unreachable even if the `trace-empty` finding below were ever
 * removed.
 */
export function buildReport(entries, counts, incomplete) {
  const findings = sortFindings(entries)
  const errors = findings.filter((finding) => finding.severity === 'error').length
  const warnings = findings.filter((finding) => finding.severity === 'warning').length
  const checked = counts.checked
  const status = incomplete || checked === 0 ? 'incomplete' : errors > 0 ? 'fail' : 'pass'
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked,
      errors,
      warnings,
      requests: counts.requests,
      redirectChains: counts.redirectChains,
      hops: counts.hops,
      loops: counts.loops,
      incompleteChains: counts.incompleteChains,
    },
    findings,
  }
}

/**
 * Walk one chain from a starting address.
 *
 * The visited set is what makes a cycle terminate: a URL is followed at most
 * once per chain, so `A -> B -> A` closes on its second sight of `A` and stops.
 * The hop bound catches the other shape — a very long chain of distinct
 * addresses — and reports the bound by name rather than returning a quietly
 * shorter answer.
 */
function walkChain(start, byUrl, limits, visitedGlobally) {
  const hops = []
  const seen = new Set()
  let current = start
  let outcome = 'terminal'
  let loopBackTo = null
  let missingTarget = null

  for (;;) {
    if (seen.has(current)) {
      outcome = 'loop'
      loopBackTo = current
      break
    }
    if (hops.length >= limits.maxChainHops) {
      // The bound is checked before the lookup so a chain that is both too long
      // and missing its next capture is reported by the limit it broke.
      outcome = 'hop-limit'
      break
    }
    const hop = byUrl.get(current)
    if (hop === undefined) {
      outcome = 'target-not-captured'
      missingTarget = current
      break
    }
    seen.add(current)
    visitedGlobally.add(current)
    hops.push(hop)

    if (!hop.captured) {
      outcome = 'response-missing'
      break
    }
    if (hop.status >= 300 && hop.status <= 399 && !hop.redirect) {
      outcome = 'unfollowed'
      break
    }
    if (!hop.redirect) {
      outcome = 'terminal'
      break
    }
    if (hop.target === null) {
      outcome = 'location-unusable'
      break
    }
    current = hop.target
  }

  const sequence = hops.map((hop) => hop.url)
  if (loopBackTo !== null) sequence.push(loopBackTo)
  if (missingTarget !== null) sequence.push(missingTarget)

  return {
    start,
    hops,
    sequence,
    outcome,
    loopBackTo,
    missingTarget,
    redirects: hops.filter((hop) => hop.redirect).length,
    destination: outcome === 'terminal' ? hops[hops.length - 1].url : null,
  }
}

/** Build the chain list from hop records, deterministically and from roots first. */
function buildChains(hops, limits) {
  const byUrl = new Map()
  for (const hop of hops) {
    if (!byUrl.has(hop.url)) byUrl.set(hop.url, hop)
  }
  const targets = new Set()
  for (const hop of hops) {
    if (hop.target !== null) targets.add(hop.target)
  }

  const addresses = [...byUrl.keys()].sort(byCodeUnit)
  const visitedGlobally = new Set()
  const chains = []

  for (const address of addresses) {
    if (targets.has(address)) continue
    chains.push(walkChain(address, byUrl, limits, visitedGlobally))
  }
  // Whatever is left was reached by no chain walked above: a cycle nothing
  // leads into, or the tail of a chain that stopped at the hop bound. Every
  // captured address is mapped from somewhere, or a pure loop would go
  // unreported and a bounded chain would lose its remainder in silence.
  for (const address of addresses) {
    if (visitedGlobally.has(address)) continue
    chains.push(walkChain(address, byUrl, limits, visitedGlobally))
  }
  return chains
}

function arrow(sequence) {
  return sequence.join(' -> ')
}

/** Findings a single mapped chain earns. */
function reportChain(chain, index, limits, emit) {
  const pointer = `/chains/${index}`

  if (chain.redirects >= 1) {
    emit({
      ruleId: 'chain-mapped',
      message:
        chain.destination === null
          ? `${chain.redirects} redirect(s) from ${chain.start}; no destination was captured`
          : `${chain.redirects} redirect(s) from ${chain.start} to ${chain.destination}`,
      pointer,
      evidence: arrow(chain.sequence),
    })
  }

  if (chain.outcome === 'loop') {
    emit({
      ruleId: 'redirect-loop',
      message: `the chain returns to ${chain.loopBackTo} and cannot terminate`,
      pointer,
      evidence: `${arrow(chain.sequence)} (loop)`,
      suggestion: 'break the cycle at one of these hops',
    })
  } else if (chain.outcome === 'target-not-captured') {
    emit({
      ruleId: 'chain-target-not-captured',
      message: `the chain redirects to ${chain.missingTarget}, which the capture never requested, so its destination is unknown`,
      pointer,
      evidence: arrow(chain.sequence),
      suggestion: 're-capture with redirects followed to the end',
    })
  } else if (chain.outcome === 'response-missing') {
    emit(
      chain.redirects >= 1
        ? {
            ruleId: 'chain-response-missing',
            message: `the last hop ${chain.hops[chain.hops.length - 1].url} was requested but no response was captured, so the destination is unknown`,
            pointer,
            evidence: arrow(chain.sequence),
            suggestion: 're-capture; the destination was not inferred',
          }
        : {
            ruleId: 'request-not-captured',
            message: `${chain.start} was requested but no response was captured. It redirects nowhere that this capture shows.`,
            pointer,
          },
    )
  } else if (chain.outcome === 'hop-limit') {
    emit({
      ruleId: 'hop-limit-exceeded',
      message: `the chain is longer than the maxChainHops limit of ${limits.maxChainHops}; it was not followed further`,
      pointer,
      evidence: arrow(chain.sequence),
      suggestion: 'raise --limit maxChainHops if the chain really is this long',
    })
  }

  if (chain.redirects > limits.maxChainLength) {
    emit({
      ruleId: 'chain-too-long',
      message: `${chain.redirects} redirects, above the maxChainLength policy of ${limits.maxChainLength}`,
      pointer,
      evidence: arrow(chain.sequence),
      suggestion: 'collapse the intermediate hops into one redirect',
    })
  }

  const schemes = []
  let downgrade = null
  for (let index_ = 0; index_ < chain.sequence.length; index_ += 1) {
    const scheme = schemeOf(chain.sequence[index_])
    if (!schemes.includes(scheme)) schemes.push(scheme)
    if (index_ === 0) continue
    const previous = schemeOf(chain.sequence[index_ - 1])
    if (downgrade === null && previous === 'https' && scheme === 'http') {
      downgrade = [chain.sequence[index_ - 1], chain.sequence[index_]]
    }
  }
  if (downgrade !== null) {
    emit({
      ruleId: 'scheme-downgrade',
      message: `the chain redirects from https to http at ${downgrade[0]}`,
      pointer,
      evidence: arrow(downgrade),
      suggestion: 'redirect to the https address instead',
    })
  } else if (schemes.length > 1) {
    emit({
      ruleId: 'mixed-scheme',
      message: `the chain spans more than one scheme: ${schemes.sort(byCodeUnit).join(', ')}`,
      pointer,
      evidence: arrow(chain.sequence),
    })
  }
}

/** Rule ids that make the run incomplete, checked against the declared list. */
function marksIncomplete(ruleId) {
  return INCOMPLETE_RULES.includes(ruleId)
}

/**
 * Map a capture.
 *
 * Returns the report envelope, the mapped chains, and the name the input was
 * reported under. Configuration problems throw `ConfigError`: the run never had
 * a subject, so there is nothing to report about.
 */
export async function mapTrace({ trace, root = null, format = 'auto', limits: overrides = {} } = {}) {
  if (!FORMATS.includes(format)) {
    throw new ConfigError(`Unknown format "${format}". Known formats: ${FORMATS.join(', ')}`)
  }
  const limits = validateLimits(overrides)
  const input = await resolveInputPath(trace, root)
  const { findings: collected, emit } = collector(input.file)

  const raise = (raw) => {
    emit(raw)
    return marksIncomplete(raw.ruleId)
  }

  let incomplete = false

  const read = await readTraceDocument(input.path, limits)
  if (read.problem !== undefined) {
    incomplete = raise(read.problem) || incomplete
    return {
      file: input.file,
      chains: [],
      report: buildReport(collected, emptyCounts(), incomplete),
    }
  }

  const extracted = extractHops(read.document, { format, limits })
  for (const finding of extracted.findings) {
    incomplete = raise(finding) || incomplete
  }

  if (!extracted.captureComplete) {
    incomplete =
      raise({
        ruleId: 'capture-declared-incomplete',
        message: 'the capture declares captureComplete: false, so any chain in it may stop short of its real destination',
        pointer: '/captureComplete',
      }) || incomplete
  }

  if (extracted.fatal) {
    return {
      file: input.file,
      chains: [],
      report: buildReport(collected, emptyCounts(), incomplete),
    }
  }

  const chains = buildChains(extracted.hops, limits)
  chains.forEach((chain, index) => reportChain(chain, index, limits, emit))
  for (const entry of collected) {
    if (marksIncomplete(entry.finding.ruleId)) incomplete = true
  }

  if (chains.length === 0 && !incomplete) {
    incomplete =
      raise({
        ruleId: 'trace-empty',
        message: 'the capture holds no request this tool could map, so nothing was checked',
        pointer: '',
        suggestion: 'a run that checked nothing is never reported as a pass',
      }) || incomplete
  } else if (
    chains.length > 0 &&
    chains.every((chain) => chain.redirects === 0 && chain.outcome === 'terminal')
  ) {
    // Only when every mapped chain really did reach a terminal response. A
    // chain that stopped at an unfollowed 3xx, or at a request with no captured
    // response, has not been shown to redirect nowhere.
    emit({
      ruleId: 'no-redirects',
      message: `${chains.length} request(s) were mapped and none of them redirected`,
      pointer: '',
    })
  }

  const counts = {
    checked: chains.length,
    requests: extracted.hops.length,
    redirectChains: chains.filter((chain) => chain.redirects >= 1).length,
    hops: chains.reduce((total, chain) => total + chain.hops.length, 0),
    loops: chains.filter((chain) => chain.outcome === 'loop').length,
    incompleteChains: chains.filter((chain) => chain.destination === null && chain.redirects >= 1).length,
  }

  return { file: input.file, chains, report: buildReport(collected, counts, incomplete) }
}

function emptyCounts() {
  return { checked: 0, requests: 0, redirectChains: 0, hops: 0, loops: 0, incompleteChains: 0 }
}

const SEVERITY_WIDTH = 7

/** Human-readable summary. The CLI writes this to stderr, never to stdout. */
export function formatReport(report, chains) {
  const lines = [`${report.tool}: ${report.status}`]
  lines.push(
    `  mapped ${report.summary.checked} chain(s) over ${report.summary.requests} request(s): ` +
      `${report.summary.redirectChains} with redirects, ${report.summary.hops} hop(s), ` +
      `${report.summary.loops} loop(s), ${report.summary.incompleteChains} without a captured destination`,
  )
  lines.push(`  ${report.summary.errors} error(s), ${report.summary.warnings} warning(s)`)
  for (const chain of chains ?? []) {
    if (chain.redirects === 0) continue
    lines.push(`  chain ${arrow(chain.sequence)} [${chain.outcome}]`)
  }
  for (const finding of report.findings) {
    const where = finding.location.pointer === undefined ? finding.location.file : finding.location.pointer
    lines.push(`  ${finding.severity.padEnd(SEVERITY_WIDTH)} ${finding.ruleId}  ${where}`)
    lines.push(`          ${finding.message}`)
  }
  return `${lines.join('\n')}\n`
}

/** Map a report status onto the documented process exit code. */
export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}
