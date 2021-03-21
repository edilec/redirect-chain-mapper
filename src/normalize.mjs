/**
 * URL identity and `Location` resolution.
 *
 * Two questions decide every chain this tool draws: "is this the same address
 * I have already seen?" and "where does this `Location` point?". Both are
 * answered here, once, so the walker never re-derives them and never guesses.
 *
 * Resolution follows RFC 7231 section 7.1.2: a `Location` field value is a
 * URI-reference, resolved against the effective request URI using RFC 3986
 * reference resolution. `URL` implements the WHATWG algorithm, which agrees
 * with RFC 3986 on every reference shape a redirect uses; the one divergence
 * that matters — WHATWG silently deletes tab and newline characters from a
 * reference — is closed before parsing by refusing a value that still holds a
 * control character after its surrounding whitespace is trimmed.
 */

/**
 * Ordering comparator for every sorted list this tool produces.
 *
 * Deliberately not `localeCompare`: collation depends on the ICU data compiled
 * into a particular Node build, so the same input can order differently on two
 * machines. Comparing UTF-16 code units is total, stable and build-independent.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** Redirect statuses this tool follows. */
export const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308])

/** Schemes a redirect may target. Anything else terminates the chain. */
export const SUPPORTED_SCHEMES = Object.freeze(['http:', 'https:'])

/** ASCII whitespace trimmed from a header field value before it is read. */
const FIELD_WHITESPACE = /^[\t\n\r ]+|[\t\n\r ]+$/g

/**
 * True when the value still holds a C0 control character or DEL.
 *
 * Written as a code-unit scan rather than a regular expression so the source
 * file cannot come to hold a literal control character of its own, and so the
 * boundary is stated in numbers a reader can check against the specification.
 */
function hasControlCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/**
 * A `Location` value, or a request URL, that cannot be turned into an address.
 *
 * `code` names the reason so the caller can pick the rule id without matching
 * on prose.
 */
export class UrlError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UrlError'
    this.code = code
  }
}

function finish(url) {
  url.hash = ''
  // `new URL('http://a/b?')` keeps a trailing '?' in href while `search` is
  // empty. Two spellings of "no query" must not become two chain nodes.
  if (url.search === '') url.search = ''
  return url
}

/**
 * The canonical form of an absolute http(s) URL.
 *
 * Scheme and host case, the default port and an empty query are normalised by
 * the URL parser; the fragment is dropped because it is never sent to a server
 * and so cannot influence a redirect. Percent-encoding and query order are left
 * exactly as captured — changing either would silently merge addresses that a
 * server distinguishes.
 */
export function normalizeUrl(value, { label = 'URL' } = {}) {
  if (typeof value !== 'string') throw new UrlError('invalid', `${label} must be a string`)
  const trimmed = value.replace(FIELD_WHITESPACE, '')
  if (trimmed === '') throw new UrlError('empty', `${label} is empty`)
  if (hasControlCharacter(trimmed)) {
    throw new UrlError('unsafe', `${label} contains a control character`)
  }
  let url
  try {
    url = new URL(trimmed)
  } catch {
    throw new UrlError('invalid', `${label} is not an absolute URL`)
  }
  if (!SUPPORTED_SCHEMES.includes(url.protocol)) {
    throw new UrlError(
      'unsupported-scheme',
      `${label} uses the unsupported scheme "${url.protocol.slice(0, -1)}"`,
    )
  }
  return finish(url).href
}

/**
 * Resolve a captured `Location` value against the URL that was requested.
 *
 * Returns the normalised target and whether the value was written as a relative
 * reference, which the report states rather than leaving the reader to compare
 * two addresses by eye.
 */
export function resolveLocation(requestUrl, value) {
  if (typeof value !== 'string') throw new UrlError('invalid', 'Location must be a string')
  const trimmed = value.replace(FIELD_WHITESPACE, '')
  if (trimmed === '') throw new UrlError('empty', 'Location is empty')
  if (hasControlCharacter(trimmed)) {
    throw new UrlError('unsafe', 'Location contains a control character')
  }
  let url
  try {
    url = new URL(trimmed, requestUrl)
  } catch {
    throw new UrlError('invalid', `Location "${trimmed}" could not be resolved against the request URL`)
  }
  if (!SUPPORTED_SCHEMES.includes(url.protocol)) {
    throw new UrlError(
      'unsupported-scheme',
      `Location resolves to the unsupported scheme "${url.protocol.slice(0, -1)}"`,
    )
  }
  return { url: finish(url).href, relative: !isAbsoluteReference(trimmed) }
}

/** True when the reference stands on its own without a base. */
function isAbsoluteReference(value) {
  try {
    return Boolean(new URL(value))
  } catch {
    return false
  }
}

/** The scheme of a normalised URL, without the colon. */
export function schemeOf(url) {
  const colon = url.indexOf(':')
  return colon === -1 ? '' : url.slice(0, colon)
}

/** True when `status` is a redirect this tool follows. */
export function isRedirectStatus(status) {
  return REDIRECT_STATUSES.includes(status)
}

/** True when `status` is a 3xx that is not a followed redirect. */
export function isOtherThreeHundred(status) {
  return Number.isInteger(status) && status >= 300 && status <= 399 && !isRedirectStatus(status)
}
