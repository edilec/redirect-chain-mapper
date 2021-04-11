# Redirect Chain Mapper

Read a captured trace — a HAR 1.2 export or a small JSON trace — and draw the redirect chains it
actually contains: where each one starts, every hop it takes, how many hops that is, whether it
closes into a loop, whether it changes scheme, and where it ends.

- **Repository:** [edilec/redirect-chain-mapper](https://github.com/edilec/redirect-chain-mapper)
- **Area:** SEO & Search
- **License:** MIT

The tool never makes a request. Every address in the report came out of the file you passed, and the
one thing it refuses to do is invent the end of a chain: a chain whose last hop has no captured
response, or whose target the capture never requested, is reported as `incomplete` with no
destination. "I do not know where this goes" and "this goes to X" are different answers, and only
one of them is true.

## Install

No dependencies, runtime or development. Node 22 or newer.

```sh
git clone https://github.com/edilec/redirect-chain-mapper.git
cd redirect-chain-mapper
npm run check
```

## Use

```sh
redirect-chain-mapper --trace capture.har
redirect-chain-mapper --trace trace.json --limit maxChainLength=2 --json
redirect-chain-mapper --trace captures/run-12.json --root ./artifacts
```

| Option | Meaning |
| --- | --- |
| `--trace FILE` | The capture to read. Required. |
| `--root DIR` | Input root the trace path is resolved inside and may not escape, lexically or through a symbolic link. Use it when the path came from a manifest rather than from you. |
| `--format FORMAT` | `auto` (default), `har` or `trace`. Pinning it turns a shape mismatch into a reported finding instead of a guess. |
| `--limit NAME=N` | Override a declared limit. Repeatable. An unknown name is refused. |
| `--json` | Suppress the human summary on stderr. |
| `-h`, `--help` | Usage. |

stdout carries the JSON report and nothing else, so it pipes straight into a parser. The human
summary and the chain map go to stderr.

| Exit | Meaning |
| ---: | --- |
| `0` | at least one chain was mapped and every one of them terminated within policy |
| `1` | the check completed and found a failure |
| `2` | invalid configuration (stdout is **empty**), or an input that could not be read, decoded or parsed (stdout carries an `incomplete` report) |

## Input

A HAR 1.2 export works as-is. The smaller trace shape is for captures written by hand or emitted by
another tool:

```json
{
  "captureComplete": true,
  "requests": [
    { "url": "https://example.com/blog/old-post", "status": 301, "location": "/blog/new-post" },
    { "url": "https://example.com/blog/new-post", "status": 308, "location": "post" },
    { "url": "https://example.com/blog/post",     "status": 200 }
  ]
}
```

A request with no `status` means **no response was captured** — which is how a truncated capture is
expressed, and why it is never mistaken for a destination. `docs/redirect-rules.md` documents both
shapes, all 31 rules, the declared limits and the determinism guarantee.

## API

```js
import { mapTrace, exitCodeFor } from 'redirect-chain-mapper'

const { report, chains } = await mapTrace({ trace: 'capture.har', limits: { maxChainLength: 2 } })
console.log(report.status, chains[0]?.destination)
process.exitCode = exitCodeFor(report)
```

`mapTrace` returns the report-contract v1 envelope, the mapped chains, and the name the input was
reported under. A configuration problem throws `ConfigError`: the run never had a subject, so there
is nothing to report about.

## Limits and non-goals

What this tool **cannot** conclude:

- **That a redirect still behaves this way.** Everything comes from a capture taken at some past
  moment. Nothing is fetched, no time is compared against a clock, and a capture that was already
  stale when it was written looks exactly like a fresh one.
- **Where an unterminated chain goes.** A target the capture never requested, a hop with no captured
  response, an unusable `Location`, a 3xx outside the five followed statuses, and a chain that hit
  `maxChainHops` all produce *no destination* and an `incomplete` run. That is the answer, not a gap
  to be filled in.
- **That a capture is complete.** A capture is only as complete as whatever produced it. A browser
  that stopped following, a proxy that dropped an entry, and a trace written from memory all look
  the same from here. Set `captureComplete: false` when you know it was truncated.
- **What a client would actually do.** Method changes across 301/302/303, cookie and authorisation
  stripping across hosts, HSTS upgrades, `Refresh` headers, meta-refresh and JavaScript redirects
  are all out of scope. Only the HTTP `Location` mechanism is mapped.
- **That two addresses are the same page.** URL identity is lexical after normalising scheme and
  host case, the default port, an empty query and the fragment. Percent-encoding, path case and
  query order are left exactly as captured, so a server that treats `/A` and `/a` alike will look
  like two chains here.
- **That a chain which terminates is correct.** It may terminate cleanly at the wrong page, at a
  404, or at a soft error. Only the *shape* of the chain is checked.
- **That the site is fine.** This is a resolution check over one capture, not a review and not a
  release approval.

Two more boundaries worth stating plainly:

- **A broken redirect fails; a missing one is incomplete.** An unusable `Location` is captured
  evidence of a defect, so it is an `error`. An uncaptured response is *absent* evidence, so it is
  `incomplete`. The two are never merged.
- **`checked: 0` is never a pass.** A run that mapped no chain saw no evidence. It reports
  `trace-empty` and exits 2.

## Development

```sh
npm test          # behaviour tests, through the API and the real CLI
npm run check     # lint, tests, runnable example, packaging check
```

`examples/clean/trace.json` exits 0. `examples/broken/trace.json` exits 1, `truncated.json` and
`capture.har` exit 2.

## License

MIT. See [LICENSE](./LICENSE).
