import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UrlError,
  byCodeUnit,
  isOtherThreeHundred,
  isRedirectStatus,
  normalizeUrl,
  resolveLocation,
  schemeOf,
} from '../src/normalize.mjs'

/**
 * RFC 7231 section 7.1.2: a `Location` value is a URI-reference resolved
 * against the effective request URI. Each row is an exact expected address, not
 * a property of one — an assertion that cannot name the wrong answer cannot
 * catch it.
 */
const RESOLUTION = [
  ['https://example.com/blog/old', '/new', 'https://example.com/new', true],
  ['https://example.com/blog/old', 'new', 'https://example.com/blog/new', true],
  ['https://example.com/blog/', 'new', 'https://example.com/blog/new', true],
  ['https://example.com/a/b/c', '../up', 'https://example.com/a/up', true],
  ['https://example.com/a/b/c', './same', 'https://example.com/a/b/same', true],
  ['https://example.com/a?x=1', '?y=2', 'https://example.com/a?y=2', true],
  ['https://example.com/a', '//other.example.net/b', 'https://other.example.net/b', true],
  ['http://example.com/a', '//other.example.net/b', 'http://other.example.net/b', true],
  ['https://example.com/a', 'https://other.example.net/b', 'https://other.example.net/b', false],
  ['https://example.com/a', 'http://example.com/a', 'http://example.com/a', false],
  ['https://example.com/a#top', '/b#frag', 'https://example.com/b', true],
  ['https://example.com/a', '  /spaced  ', 'https://example.com/spaced', true],
]

test('a Location resolves against the request URL exactly as RFC 7231 requires', () => {
  const actual = RESOLUTION.map(([base, location]) => {
    const resolved = resolveLocation(base, location)
    return [resolved.url, resolved.relative]
  })
  const expected = RESOLUTION.map(([, , url, relative]) => [url, relative])
  assert.deepEqual(actual, expected)
  // The table must actually exercise both answers, or the comparison above
  // could pass while one half of the behaviour was never reached.
  assert.ok(expected.some((row) => row[1] === true))
  assert.ok(expected.some((row) => row[1] === false))
})

test('an empty Location is refused rather than resolved to the request URL', () => {
  // WHATWG resolution of '' against a base yields the base itself, which would
  // silently turn a broken redirect into a self-loop the server never sent.
  assert.throws(() => resolveLocation('https://example.com/a', ''), (error) => {
    assert.ok(error instanceof UrlError)
    assert.equal(error.code, 'empty')
    return true
  })
  assert.throws(() => resolveLocation('https://example.com/a', '   '), { code: 'empty' })
})

test('a Location carrying a control character is refused, not repaired', () => {
  // WHATWG URL parsing deletes tab and newline from a reference. Refusing first
  // keeps a header-splitting value out of the report instead of normalising it
  // into an address the server never named.
  const split = `/next${String.fromCharCode(13)}${String.fromCharCode(10)}Set-Cookie: a=b`
  assert.throws(() => resolveLocation('https://example.com/a', split), { code: 'unsafe' })
  assert.throws(
    () => resolveLocation('https://example.com/a', `/ne${String.fromCharCode(9)}xt`),
    { code: 'unsafe' },
  )
})

test('a Location outside http and https terminates instead of being followed', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'mailto:a@b.c']) {
    assert.throws(() => resolveLocation('https://example.com/a', value), { code: 'unsupported-scheme' }, value)
  }
})

test('normalizeUrl keeps the identity a server distinguishes and drops what it never sees', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path'), 'https://example.com/Path')
  assert.equal(normalizeUrl('https://example.com:443/a'), 'https://example.com/a')
  assert.equal(normalizeUrl('http://example.com:80/a'), 'http://example.com/a')
  assert.equal(normalizeUrl('https://example.com/a#fragment'), 'https://example.com/a')
  assert.equal(normalizeUrl('https://example.com/a?'), 'https://example.com/a')
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/')
  assert.equal(normalizeUrl('https://example.com/a?b=2&a=1'), 'https://example.com/a?b=2&a=1')
  assert.equal(normalizeUrl('https://example.com/a%2Fb'), 'https://example.com/a%2Fb')
})

test('normalizeUrl refuses a relative reference, which has no identity of its own', () => {
  assert.throws(() => normalizeUrl('/relative'), { code: 'invalid' })
  assert.throws(() => normalizeUrl(''), { code: 'empty' })
  assert.throws(() => normalizeUrl(42), { code: 'invalid' })
  assert.throws(() => normalizeUrl('ftp://example.com/a'), { code: 'unsupported-scheme' })
})

test('ordering is by UTF-16 code unit, which locale collation would get wrong', () => {
  // 'S' (0x53) precedes '_' (0x5F) by code unit, while collation treats the
  // underscore as ignorable punctuation and orders these the other way round.
  const input = ['MAX_DUPLICATE_URL_ENTRIES', 'MAX_DUPLICATE_URLS']
  assert.deepEqual([...input].sort(byCodeUnit), ['MAX_DUPLICATE_URLS', 'MAX_DUPLICATE_URL_ENTRIES'])
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('a', 'b'), -1)
  assert.equal(byCodeUnit('b', 'a'), 1)
  // http sorts before https because ':' (0x3A) precedes 's' (0x73).
  assert.deepEqual(
    ['https://e.com/a', 'http://e.com/a'].sort(byCodeUnit),
    ['http://e.com/a', 'https://e.com/a'],
  )
})

test('scheme and status helpers name exactly the documented sets', () => {
  assert.equal(schemeOf('https://example.com/a'), 'https')
  assert.equal(schemeOf('http://example.com/a'), 'http')
  assert.deepEqual(
    [300, 301, 302, 303, 304, 307, 308, 200, 404].filter((status) => isRedirectStatus(status)),
    [301, 302, 303, 307, 308],
  )
  assert.deepEqual(
    [300, 301, 304, 305, 399, 400].filter((status) => isOtherThreeHundred(status)),
    [300, 304, 305, 399],
  )
})
