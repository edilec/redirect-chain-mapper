/**
 * Reading a capture and turning it into hops.
 *
 * Two input shapes are understood: HAR 1.2 (`log.entries`, as exported by a
 * browser's network panel or a proxy) and a smaller hand-written JSON trace.
 * Both are reduced to the same hop record, so the chain walker never learns
 * which one it came from.
 *
 * Nothing here infers. A response that was not captured stays uncaptured, a
 * `Location` that cannot be resolved stays unresolved, and both travel to the
 * report as what they are. The one thing this module must never do is supply a
 * destination the capture did not contain.
 */

import { readFile, stat } from 'node:fs/promises'

import {
  UrlError,
  isOtherThreeHundred,
  isRedirectStatus,
  normalizeUrl,
  resolveLocation,
} from './normalize.mjs'

/** Accepted values for the input format option. */
export const FORMATS = Object.freeze(['auto', 'har', 'trace'])

/** HAR versions this tool claims to understand. */
const KNOWN_HAR_VERSIONS = Object.freeze(['1.1', '1.2'])

/** Top-level keys the simple trace shape allows. Anything else is a typo, not a field. */
const TRACE_KEYS = Object.freeze(['requests', 'captureComplete', 'comment'])

/** Per-request keys the simple trace shape allows. */
const REQUEST_KEYS = Object.freeze(['url', 'method', 'status', 'location', 'headers', 'comment'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** The rule id a `UrlError` code maps onto when it came from a `Location` value. */
export const LOCATION_RULE = Object.freeze({
  empty: 'location-empty',
  unsafe: 'location-unsafe',
  invalid: 'location-invalid',
  'unsupported-scheme': 'location-unsupported-scheme',
})

/**
 * Read the capture, with every declared input bound applied before any of it is
 * interpreted.
 *
 * Decoding is strict on purpose. `TextDecoder` in fatal mode refuses a byte
 * sequence that is not UTF-8 instead of substituting U+FFFD, so undecodable
 * bytes become a reported failure rather than text that merely looks odd. The
 * encoding verdict never comes from inspecting the decoded characters: a file
 * may legitimately contain a literal U+FFFD, and treating that as evidence of
 * bad bytes is how an unreadable input comes to be reported as a pass.
 */
export async function readTraceDocument(path, limits) {
  let size
  try {
    const info = await stat(path)
    if (!info.isFile()) {
      return { problem: { ruleId: 'input-unreadable', message: 'the trace path is not a regular file', pointer: '/input' } }
    }
    size = info.size
  } catch (error) {
    return {
      problem: {
        ruleId: 'input-unreadable',
        message: `the trace could not be opened (${error.code ?? 'unknown error'})`,
        pointer: '/input',
        suggestion: 'check the path, and pass --root when the path comes from a manifest',
      },
    }
  }

  if (size > limits.maxInputBytes) {
    return {
      problem: {
        ruleId: 'input-too-large',
        message: `the trace is ${size} bytes, above the maxInputBytes limit of ${limits.maxInputBytes}`,
        pointer: '/input',
        suggestion: 'split the capture, or raise --limit maxInputBytes',
      },
    }
  }

  let bytes
  try {
    bytes = await readFile(path)
  } catch (error) {
    return {
      problem: {
        ruleId: 'input-unreadable',
        message: `the trace could not be read (${error.code ?? 'unknown error'})`,
        pointer: '/input',
      },
    }
  }

  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return {
      problem: {
        ruleId: 'input-not-utf8',
        message: 'the trace is not valid UTF-8 and was not decoded',
        pointer: '/input',
        suggestion: 're-export the capture as UTF-8',
      },
    }
  }

  let document
  try {
    document = JSON.parse(text)
  } catch (error) {
    return {
      problem: {
        ruleId: 'input-invalid-json',
        message: `the trace is not valid JSON: ${error.message}`,
        pointer: '/input',
      },
    }
  }

  const depth = jsonDepth(document, limits.maxJsonDepth)
  if (depth > limits.maxJsonDepth) {
    return {
      problem: {
        ruleId: 'input-too-deep',
        message: `the trace nests deeper than the maxJsonDepth limit of ${limits.maxJsonDepth}`,
        pointer: '/input',
        suggestion: 'raise --limit maxJsonDepth if the capture really is this deep',
      },
    }
  }

  return { document }
}

/**
 * Depth of a parsed JSON value, measured iteratively so a hostile nesting depth
 * cannot exhaust the call stack before the limit is reached. Counting stops one
 * past the limit; the exact depth beyond that is not interesting.
 */
function jsonDepth(value, limit) {
  let deepest = 0
  const pending = [{ value, depth: 1 }]
  while (pending.length > 0) {
    const { value: current, depth } = pending.pop()
    if (depth > deepest) deepest = depth
    if (deepest > limit) return deepest
    if (Array.isArray(current)) {
      for (const item of current) pending.push({ value: item, depth: depth + 1 })
    } else if (isRecord(current)) {
      for (const item of Object.values(current)) pending.push({ value: item, depth: depth + 1 })
    }
  }
  return deepest
}

/** Decide which shape the document is, honouring an explicit `--format`. */
export function detectFormat(document, requested) {
  if (requested === 'har') return isRecord(document) && isRecord(document.log) ? 'har' : null
  if (requested === 'trace') {
    if (Array.isArray(document)) return 'trace'
    return isRecord(document) && Array.isArray(document.requests) ? 'trace' : null
  }
  if (isRecord(document) && isRecord(document.log)) return 'har'
  if (Array.isArray(document)) return 'trace'
  if (isRecord(document) && Array.isArray(document.requests)) return 'trace'
  return null
}

/**
 * Turn a capture into hop records and the findings the capture itself earned.
 *
 * Findings carry a rule id and a location only. Severity is attached by the
 * caller from the single severity table, so no construction site here can pick
 * its own and drift away from the documented catalog.
 */
export function extractHops(document, { format, limits }) {
  const findings = []
  const shape = detectFormat(document, format)
  if (shape === null) {
    findings.push({
      ruleId: 'trace-unrecognized',
      message:
        format === 'auto'
          ? 'the document is neither a HAR (an object with a "log" object) nor a trace (an array, or an object with a "requests" array)'
          : `the document does not have the shape requested by --format ${format}`,
      pointer: '',
      suggestion: 'export a HAR 1.2 file, or use the documented trace shape',
    })
    return { shape: null, hops: [], captureComplete: true, findings, fatal: true }
  }

  const parsed = shape === 'har' ? readHarEntries(document, findings) : readTraceEntries(document, findings)
  if (parsed.entries.length > limits.maxEntries) {
    findings.push({
      ruleId: 'entry-limit-exceeded',
      message: `the capture holds ${parsed.entries.length} entries, above the maxEntries limit of ${limits.maxEntries}. No chain was mapped.`,
      pointer: parsed.basePointer,
      suggestion: 'split the capture, or raise --limit maxEntries',
    })
    return { shape, hops: [], captureComplete: parsed.captureComplete, findings, fatal: true }
  }

  const hops = []
  for (const entry of parsed.entries) {
    const hop = toHop(entry, findings)
    if (hop !== null) hops.push(hop)
  }
  return { shape, hops, captureComplete: parsed.captureComplete, findings, fatal: false }
}

function readHarEntries(document, findings) {
  const log = document.log
  const version = log.version
  if (typeof version !== 'string' || !KNOWN_HAR_VERSIONS.includes(version)) {
    findings.push({
      ruleId: 'har-version-unsupported',
      message: `HAR version ${version === undefined ? 'is missing' : `"${String(version).slice(0, 40)}" is not one of ${KNOWN_HAR_VERSIONS.join(', ')}`}; its entries were read but nothing about them is vouched for`,
      pointer: '/log/version',
    })
  }
  if (!Array.isArray(log.entries)) {
    findings.push({
      ruleId: 'trace-unrecognized',
      message: 'the HAR log has no "entries" array',
      pointer: '/log/entries',
    })
    return { entries: [], captureComplete: true, basePointer: '/log/entries' }
  }

  const entries = log.entries.map((raw, index) => {
    const pointer = `/log/entries/${index}`
    if (!isRecord(raw)) return { pointer, invalid: 'entry is not an object' }
    const request = isRecord(raw.request) ? raw.request : null
    const response = isRecord(raw.response) ? raw.response : null
    if (request === null) return { pointer, invalid: 'entry has no request object' }

    const status = response !== null && Number.isInteger(response.status) ? response.status : null
    // HAR records a request that never produced a response with status 0.
    const captured = status !== null && status >= 100 && status <= 599
    const headerLocations = response === null ? [] : locationHeaders(response.headers)
    const redirectUrl =
      response !== null && typeof response.redirectURL === 'string' && response.redirectURL.trim() !== ''
        ? response.redirectURL
        : null

    return {
      pointer,
      url: request.url,
      method: typeof request.method === 'string' ? request.method : null,
      statusGiven: response === null ? undefined : response.status,
      status,
      captured,
      headerLocations,
      fieldLocation: null,
      redirectUrl,
    }
  })
  return { entries, captureComplete: true, basePointer: '/log/entries' }
}

function readTraceEntries(document, findings) {
  const bare = Array.isArray(document)
  const list = bare ? document : document.requests
  const basePointer = bare ? '' : '/requests'
  let captureComplete = true

  if (!bare) {
    for (const key of Object.keys(document)) {
      if (!TRACE_KEYS.includes(key)) {
        findings.push({
          ruleId: 'trace-unknown-field',
          message: `unknown top-level field "${key}". Known fields: ${TRACE_KEYS.join(', ')}`,
          pointer: `/${key}`,
          suggestion: 'remove the field, or correct its spelling',
        })
      }
    }
    if (document.captureComplete !== undefined) {
      if (typeof document.captureComplete !== 'boolean') {
        findings.push({
          ruleId: 'trace-unknown-field',
          message: 'captureComplete must be true or false',
          pointer: '/captureComplete',
        })
      } else {
        captureComplete = document.captureComplete
      }
    }
  }

  const entries = list.map((raw, index) => {
    const pointer = `${basePointer}/${index}`
    if (!isRecord(raw)) return { pointer, invalid: 'request is not an object' }
    for (const key of Object.keys(raw)) {
      if (!REQUEST_KEYS.includes(key)) {
        findings.push({
          ruleId: 'trace-unknown-field',
          message: `unknown request field "${key}". Known fields: ${REQUEST_KEYS.join(', ')}`,
          pointer: `${pointer}/${key}`,
          suggestion: 'remove the field, or correct its spelling',
        })
      }
    }

    let status = null
    let captured = false
    if (raw.status !== undefined && raw.status !== null) {
      if (!Number.isInteger(raw.status) || raw.status < 100 || raw.status > 599) {
        return { pointer, url: raw.url, invalid: `status must be an integer from 100 to 599, got ${JSON.stringify(raw.status)}` }
      }
      status = raw.status
      captured = true
    }

    return {
      pointer,
      url: raw.url,
      method: typeof raw.method === 'string' ? raw.method : null,
      statusGiven: raw.status,
      status,
      captured,
      headerLocations: locationHeaders(raw.headers),
      fieldLocation: typeof raw.location === 'string' ? raw.location : null,
      redirectUrl: null,
    }
  })

  return { entries, captureComplete, basePointer: basePointer === '' ? '' : basePointer }
}

/** Every distinct `Location` field value, matched case-insensitively as HTTP requires. */
function locationHeaders(headers) {
  if (!Array.isArray(headers)) return []
  const values = []
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== 'string' || typeof header.value !== 'string') continue
    if (header.name.toLowerCase() !== 'location') continue
    if (!values.includes(header.value)) values.push(header.value)
  }
  return values
}

/**
 * Reduce one capture entry to a hop.
 *
 * Returns `null` when the entry has no usable identity, because a hop with no
 * address cannot be a node in any chain. Everything else — an uncaptured
 * response, an unusable `Location` — becomes a hop whose `target` is `null`,
 * which is the walker's signal that the destination is unknown.
 */
function toHop(entry, findings) {
  if (entry.invalid !== undefined) {
    findings.push({
      ruleId: 'entry-invalid',
      message: entry.invalid,
      pointer: entry.pointer,
      evidence: typeof entry.url === 'string' ? entry.url : undefined,
    })
    return null
  }

  let url
  try {
    url = normalizeUrl(entry.url, { label: 'the request URL' })
  } catch (error) {
    if (!(error instanceof UrlError)) throw error
    findings.push({
      ruleId: 'entry-invalid',
      message: error.message,
      pointer: `${entry.pointer}/url`,
      evidence: typeof entry.url === 'string' ? entry.url : String(entry.url),
    })
    return null
  }

  const hop = {
    pointer: entry.pointer,
    url,
    method: entry.method === null ? 'GET' : entry.method.toUpperCase(),
    captured: entry.captured,
    status: entry.status,
    redirect: entry.captured && isRedirectStatus(entry.status),
    location: null,
    locationRelative: false,
    target: null,
  }

  if (!entry.captured) return hop

  if (isOtherThreeHundred(entry.status)) {
    findings.push({
      ruleId: 'redirect-status-unusual',
      message: `status ${entry.status} is a 3xx this tool does not follow; the chain stops here`,
      pointer: `${entry.pointer}/status`,
    })
    return hop
  }
  if (!hop.redirect) return hop

  const chosen = chooseLocation(entry, findings)
  if (chosen === null) return hop
  hop.location = chosen

  try {
    const resolved = resolveLocation(url, chosen)
    hop.target = resolved.url
    hop.locationRelative = resolved.relative
  } catch (error) {
    if (!(error instanceof UrlError)) throw error
    findings.push({
      ruleId: LOCATION_RULE[error.code] ?? 'location-invalid',
      message: error.message,
      pointer: `${entry.pointer}/location`,
      evidence: chosen,
      suggestion: 'the destination of this chain is not known and was not guessed',
    })
    return hop
  }

  compareRedirectUrl(entry, hop, findings)
  return hop
}

/** Pick the single `Location` value to resolve, reporting where it came from. */
function chooseLocation(entry, findings) {
  const { headerLocations, fieldLocation, redirectUrl, pointer } = entry

  if (headerLocations.length > 1) {
    findings.push({
      ruleId: 'location-ambiguous',
      message: `${headerLocations.length} different Location values were captured for one response`,
      pointer: `${pointer}/headers`,
      evidence: headerLocations.join(' | '),
      suggestion: 'a response must carry exactly one Location; the destination was not guessed',
    })
    return null
  }

  const header = headerLocations.length === 1 ? headerLocations[0] : null

  if (fieldLocation !== null && header !== null && fieldLocation !== header) {
    findings.push({
      ruleId: 'location-inconsistent',
      message: 'the "location" field and the captured Location header disagree; the field was used',
      pointer: `${pointer}/location`,
      evidence: `${fieldLocation} | ${header}`,
    })
  }
  if (fieldLocation !== null) return fieldLocation
  if (header !== null) return header

  if (redirectUrl !== null) {
    findings.push({
      ruleId: 'location-from-redirect-url',
      message: 'no Location header was captured; the HAR redirectURL was used instead',
      pointer: `${pointer}/redirectURL`,
      evidence: redirectUrl,
    })
    return redirectUrl
  }

  findings.push({
    ruleId: 'location-missing',
    message: `status ${entry.status} was captured with no Location value`,
    pointer: `${pointer}/headers`,
    suggestion: 're-capture with response headers, or correct the server',
  })
  return null
}

/**
 * A HAR carries both the raw header and the browser's own resolved
 * `redirectURL`. When both are present and disagree, the capture contradicts
 * itself and the reader should know which one was believed.
 */
function compareRedirectUrl(entry, hop, findings) {
  if (entry.redirectUrl === null || hop.target === null) return
  let resolved
  try {
    resolved = resolveLocation(hop.url, entry.redirectUrl).url
  } catch {
    return
  }
  if (resolved === hop.target) return
  findings.push({
    ruleId: 'location-inconsistent',
    message: 'the captured Location header and the HAR redirectURL resolve to different addresses; the header was used',
    pointer: `${entry.pointer}/redirectURL`,
    evidence: `${hop.target} | ${resolved}`,
  })
}
