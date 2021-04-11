# Input shapes, rules, limits and determinism

This document is the reference for what `redirect-chain-mapper` reads, what each rule means, what
it refuses to conclude, and what the declared limits are. Rule ids are part of the public contract:
renaming one is a breaking change and is recorded in the changelog.

## Input shapes

Two shapes are understood. `--format auto` (the default) picks between them; `--format har` or
`--format trace` pins the choice and reports `trace-unrecognized` if the document is not that shape.

### HAR 1.2

An object with a `log` object. Only these fields are read:

| Field | Use |
| --- | --- |
| `log.version` | Checked against `1.1` and `1.2`. Anything else raises `har-version-unsupported`. |
| `log.entries[]` | The captured requests, in file order. |
| `entries[].request.url` | The request URL. Required; anything unusable raises `entry-invalid`. |
| `entries[].request.method` | Reported only. Defaults to `GET`. |
| `entries[].response.status` | An integer from 100 to 599 means a response was captured. HAR records a request that never produced a response as `0`, and so does this tool. |
| `entries[].response.headers[]` | Searched for `Location`, matched case-insensitively. |
| `entries[].response.redirectURL` | Used only when no `Location` header was captured, and then `location-from-redirect-url` says so. |

Every other HAR field is ignored. A HAR is someone else's format, so unknown keys in it are not an
error.

### JSON trace

Either an array of requests, or an object:

```json
{
  "captureComplete": true,
  "requests": [
    { "url": "https://example.com/old", "method": "GET", "status": 301, "location": "/new" },
    { "url": "https://example.com/new", "method": "GET", "status": 200 }
  ]
}
```

| Field | Use |
| --- | --- |
| `requests` | Required array of request objects. |
| `captureComplete` | Optional boolean. `false` raises `capture-declared-incomplete`. |
| `comment` | Optional. Ignored. |
| `requests[].url` | Required absolute `http` or `https` URL. |
| `requests[].method` | Optional. Reported only. Defaults to `GET`. |
| `requests[].status` | Optional integer from 100 to 599. Absent or `null` means **no response was captured**. |
| `requests[].location` | Optional raw `Location` field value. Takes precedence over `headers`. |
| `requests[].headers` | Optional `[{ "name": …, "value": … }]` array, searched for `Location`. |
| `requests[].comment` | Optional. Ignored. |

This shape is the tool's own, so it is strict: any other key, at the top level or in a request,
raises `trace-unknown-field` and makes the run `incomplete`. A mistyped `status` would otherwise be
read as "no response was captured", and a typo must not quietly change what a run concludes.

## How a chain is built

1. Every entry becomes a **hop** keyed by its normalised request URL. A URL requested twice keeps
   the first response; that is what lets a cycle close on its second sight of an address.
2. A hop **redirects** when its captured status is 301, 302, 303, 307 or 308. Its `Location` value
   is resolved against its own request URL per RFC 7231 section 7.1.2.
3. A **root** is any captured address that is not the resolved target of some hop. Roots are walked
   in UTF-16 code-unit order.
4. Any address no root walk reached is then walked as its own chain — a cycle nothing leads into,
   or the tail of a chain that stopped at `maxChainHops`. Nothing captured goes unmapped.
5. A walk keeps a visited set. Reaching an address twice is a `redirect-loop` and the walk stops.

### URL identity

- Scheme and host are lowercased, a default port is dropped, an empty query (`?`) is dropped.
- The **fragment is dropped**: it is never sent to a server and so cannot affect a redirect.
- Percent-encoding, path case and query order are left exactly as captured. Two spellings a server
  distinguishes stay distinct.
- Resolution uses the WHATWG URL algorithm, which agrees with RFC 3986 on every reference shape a
  redirect uses. WHATWG additionally deletes tab and newline from a reference; this tool refuses
  such a value as `location-unsafe` first, so that divergence is never reached.

## How a chain ends

| Outcome | Meaning | Destination |
| --- | --- | --- |
| `terminal` | The last hop returned a captured non-redirect response. | that hop's URL |
| `loop` | The walk returned to an address it had already visited. | none |
| `target-not-captured` | The last redirect points at an address the capture never requested. | none |
| `response-missing` | The last hop was requested and no response was captured. | none |
| `location-unusable` | The last hop redirects but its `Location` could not be used. | none |
| `unfollowed` | The last hop returned a 3xx this tool does not follow. | none |
| `hop-limit` | The walk stopped at `maxChainHops`. | none |

**A destination is never inferred.** `terminal` is the only outcome that names one, and it names
the address the capture actually recorded a response for.

## Rule catalog

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `capture-declared-incomplete` | warning | The trace sets `captureComplete: false`, so any chain in it may stop short of its real destination. |
| `chain-mapped` | info | One chain with at least one redirect, its hop count, and its destination when the capture recorded one. |
| `chain-response-missing` | warning | The chain's last hop was requested but no response was captured, so its destination is unknown. |
| `chain-target-not-captured` | warning | The chain redirects to an address the capture never requested, so its destination is unknown. |
| `chain-too-long` | error | The chain holds more redirects than the `maxChainLength` policy allows. |
| `entry-invalid` | error | An entry has no usable request URL or an impossible status, and was dropped. |
| `entry-limit-exceeded` | error | The capture holds more entries than `maxEntries`. Nothing was mapped. |
| `har-version-unsupported` | warning | `log.version` is not 1.1 or 1.2. The entries were read but nothing about them is vouched for. |
| `hop-limit-exceeded` | error | A single chain is longer than `maxChainHops`; the walk stopped at the bound. |
| `input-invalid-json` | error | The file is not valid JSON. |
| `input-not-utf8` | error | The file is not valid UTF-8 and was not decoded. |
| `input-too-deep` | error | The JSON nests deeper than `maxJsonDepth`. |
| `input-too-large` | error | The file is larger than `maxInputBytes`. |
| `input-unreadable` | error | The file could not be opened or is not a regular file. |
| `location-ambiguous` | error | One response carried two different `Location` values; neither was chosen. |
| `location-empty` | error | A redirect carried an empty `Location`. It is refused, not resolved to the request URL. |
| `location-from-redirect-url` | info | No `Location` header was captured, so the HAR `redirectURL` was used. |
| `location-inconsistent` | warning | Two captured sources disagree about the `Location`; the message says which was believed. |
| `location-invalid` | error | The `Location` could not be resolved against the request URL. |
| `location-missing` | error | A redirect status was captured with no `Location` value at all. |
| `location-unsafe` | error | The `Location` still holds a control character after trimming — the header-splitting shape. |
| `location-unsupported-scheme` | error | The `Location` resolves to something other than `http` or `https`; the chain stops. |
| `mixed-scheme` | info | The chain spans more than one scheme without an https-to-http step. |
| `no-redirects` | info | Every mapped chain reached a terminal response without redirecting once. |
| `redirect-loop` | error | The chain returns to an address it already visited and cannot terminate. |
| `redirect-status-unusual` | warning | A 3xx outside 301, 302, 303, 307, 308 was captured; the chain was not followed past it. |
| `request-not-captured` | warning | A single request with no captured response and no redirect of its own. |
| `scheme-downgrade` | error | The chain redirects from `https` to `http`. |
| `trace-empty` | error | Nothing could be mapped, so nothing was checked. A run that saw no evidence is not a pass. |
| `trace-unknown-field` | error | A key the trace shape does not define, at the top level or in a request. |
| `trace-unrecognized` | error | The document is neither a HAR nor a trace, or not the shape `--format` requested. |

Severity comes from one frozen table, `RULE_SEVERITY` in `src/index.mjs`. `test/severity-table.test.mjs`
asserts this catalogue against it in both directions, so a rule cannot be demoted in code while the
documentation still claims it fails a build.

## Limits

| Limit | Default | Minimum | Exceeding it |
| --- | ---: | ---: | --- |
| `maxInputBytes` | 8388608 | 1 | `input-too-large`, nothing is read |
| `maxJsonDepth` | 64 | 1 | `input-too-deep`, nothing is mapped |
| `maxEntries` | 10000 | 1 | `entry-limit-exceeded`, nothing is mapped |
| `maxChainHops` | 64 | 2 | `hop-limit-exceeded` for that chain; its remainder is mapped as a new chain |
| `maxChainLength` | 3 | 0 | `chain-too-long` for that chain |

All five are set with `--limit NAME=VALUE`, repeatable, and by `limits` on the API. An unknown name
is a configuration error, not a value that is ignored. The first four are safety bounds and make the
run `incomplete`; `maxChainLength` is a policy about the site being audited and makes the run `fail`.

Evidence excerpts are additionally capped at 300 characters, flattened to one line, with control
characters replaced by spaces. Captured content is data and is never echoed unbounded.

## Status and exit code

| Status | When | Exit |
| --- | --- | ---: |
| `pass` | at least one chain was mapped, no error finding, no missing evidence | 0 |
| `fail` | at least one `error` finding, and no missing evidence | 1 |
| `incomplete` | evidence was missing, truncated, undecodable or deliberately not followed | 2 |

`incomplete` wins over `fail`, and `checked: 0` can never be `pass` — the status expression itself
refuses it, independently of the `trace-empty` finding that explains it.

There are two shapes of exit 2:

| Situation | stdout | stderr |
| --- | --- | --- |
| Invalid configuration: unknown option, unknown limit, a path outside the root | **empty** | the message |
| Input that could not be read, decoded or parsed | an `incomplete` report | optional diagnostics |

A configuration error means the run never had a subject, so there is nothing to report about.

## Determinism

Findings are ordered by `(location.file, location.pointer, ruleId)`, compared as text by UTF-16 code
unit, with the order a finding was raised breaking any remaining tie. Nothing in the output depends
on wall-clock time, locale collation, hash iteration order or filesystem enumeration order. Pointer
segments are compared as text, so `/chains/10` precedes `/chains/2`.

Running the tool twice over identical inputs produces byte-identical stdout.

## What this tool cannot conclude

- **That a redirect still behaves this way.** Everything comes from a capture taken at some past
  moment. Nothing is fetched, and no time is compared against a clock.
- **Where an unterminated chain goes.** A missing target, an uncaptured response, an unusable
  `Location` and an unfollowed 3xx all produce *no destination*. That is the answer, not a gap to be
  filled in.
- **That a chain is complete.** A capture is only as complete as whatever produced it. A browser
  that stopped following, a proxy that dropped an entry, or a trace hand-written from memory all
  look the same from here — which is why `captureComplete: false` exists and why an uncaptured hop
  is `incomplete` rather than a pass.
- **What a client would do.** Method changes across 301/302/303, cookie and authorisation stripping
  across hosts, HSTS upgrades, `Refresh` headers and meta-refresh or JavaScript redirects are all
  out of scope. Only the HTTP `Location` mechanism is mapped.
- **That a redirect is correct.** A chain that terminates cleanly may still point at the wrong page.
- **That the site is fine.** This is a resolution check over one capture, not a review and not a
  release approval.
