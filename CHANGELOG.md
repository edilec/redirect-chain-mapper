# Changelog

All notable changes to this project are documented here. The project uses
[Semantic Versioning](https://semver.org/).

Rule identifiers are part of the public contract. Renaming or removing one is a
breaking change and is recorded here.

## Unreleased

### Added

- Two input readers: HAR 1.2 (`log.entries`) and a smaller JSON trace shape,
  selected automatically or pinned with `--format`. The HAR reader also falls
  back to `response.redirectURL` when no `Location` header was captured, and
  says so.
- `Location` resolution against the request URL per RFC 7231 section 7.1.2,
  with an empty value refused rather than resolved back to the request URL, and
  a value still holding a control character after trimming refused rather than
  repaired.
- URL identity that normalises scheme and host case, the default port, an empty
  query and the fragment, and leaves percent-encoding and query order exactly as
  captured.
- `mapTrace`, which builds redirect chains from the captured hops, terminates a
  cycle on a visited set, counts hops, and reports loops, https-to-http
  downgrades, mixed schemes and chains longer than the length policy. It emits a
  report-contract v1 envelope on stdout.
- CLI with `--trace`, `--root`, `--format`, `--limit NAME=VALUE`, `--json` and
  `--help`. The JSON report goes to stdout alone; the human summary and the
  chain map go to stderr.
- Thirty-one stable rule identifiers, taken from one frozen `RULE_SEVERITY`
  table and documented in `docs/redirect-rules.md`, which is asserted against
  the table in both directions.
- Five declared limits — `maxInputBytes`, `maxJsonDepth`, `maxEntries`,
  `maxChainHops`, `maxChainLength` — each enforced, each reachable from the CLI,
  and each exercised through the real command line. An unknown limit name is a
  configuration error, not a value that is ignored.
- Input-root confinement that resolves the real path and re-checks it against
  the real root, so a symbolic link planted inside the declared root cannot be
  followed out of the tree.
- Clean and deliberately broken example captures, and tests covering the public
  API, the real CLI entry point, path confinement and determinism.

### Notes on what this tool refuses to do

- A chain whose final hop has no captured response, or whose target the capture
  never requested, is `incomplete` with no destination. The destination is never
  inferred from the `Location` of the last captured hop.
- A run that mapped no chain reports `trace-empty` and `incomplete`. `pass` with
  `checked: 0` is refused by the status expression itself, independently of that
  finding.
- A capture that could not be read, decoded or parsed is `incomplete` and exits
  2. Encoding is decided by a strict UTF-8 decode, never by inspecting the
  decoded characters.

No release has been published.
