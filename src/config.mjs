/**
 * Configuration: declared limits, and the boundary around which files may be
 * opened.
 *
 * Everything here answers a question about the *run*, never about the trace.
 * A mistake in this layer means the run never had a subject, so it is reported
 * as a configuration error with an empty stdout — not as a report about a trace
 * that was never read.
 */

import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { realpath } from 'node:fs/promises'

/**
 * Declared bounds. Every one is enforced, reachable from the CLI through
 * `--limit name=value`, and exercised by a test; a limit that is documented but
 * never wired through is the same defect as no limit at all.
 *
 * `maxChainLength` is a *policy*, not a safety bound: it is the number of
 * redirects a single chain may contain before the chain is reported as too
 * long. The other four are safety bounds, and exceeding one makes the run
 * `incomplete` rather than quietly producing a shorter answer.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxInputBytes: 8388608,
  maxJsonDepth: 64,
  maxEntries: 10000,
  maxChainHops: 64,
  maxChainLength: 3,
})

/** The smallest value each limit accepts. A chain policy of zero redirects is meaningful. */
const LIMIT_MINIMUM = Object.freeze({
  maxInputBytes: 1,
  maxJsonDepth: 1,
  maxEntries: 1,
  maxChainHops: 2,
  maxChainLength: 0,
})

/**
 * A problem with the configuration itself.
 *
 * `rule` names the refusal for the boundary checks, so a caller can tell an
 * input-root violation from an option typo without matching on prose.
 */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

/**
 * Merge caller overrides onto the declared limits.
 *
 * An unrecognised name is refused rather than ignored. A one-character typo
 * that silently leaves the real limit in place would turn an intended
 * restriction into a green run, which is exactly the failure this refusal
 * exists to prevent.
 */
export function validateLimits(overrides = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigError('Limits must be an object')
  }
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) {
      const known = Object.keys(DEFAULT_LIMITS).join(', ')
      throw new ConfigError(`Unknown limit "${name}". Known limits: ${known}`)
    }
    if (!Number.isInteger(value) || value < LIMIT_MINIMUM[name]) {
      throw new ConfigError(`Limit "${name}" must be an integer of at least ${LIMIT_MINIMUM[name]}`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function escapes(from, target) {
  const step = relative(from, target)
  return step === '..' || step.startsWith(`..${sep}`) || isAbsolute(step)
}

/**
 * The real path a target would have once every symbolic link on the way to it
 * has been followed.
 *
 * `realpath` needs the whole path to exist, but a trace file that was never
 * written must still reach the report as an unreadable input rather than a
 * configuration error. So the deepest ancestor that does exist is resolved for
 * real and the missing segments below it are appended literally: a link
 * anywhere along the existing part is still followed, and a missing leaf keeps
 * the location its parent gives it.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        // A link cycle, or a directory on the way down that cannot be read.
        // The target is unknown, so it cannot be shown to be inside the root,
        // so it is refused. The host path stays out of the message.
        throw new ConfigError(
          `${describe} could not be resolved (${error.code ?? 'unknown error'})`,
          'input-unresolvable',
        )
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Decide which file this run may open, and under what name it is reported.
 *
 * With `--root`, the trace path is data that arrived from somewhere else — a
 * manifest, a job definition, another tool — and data does not get to choose
 * which files are opened. Spelling a path is not the only way to leave a tree:
 * a symbolic link planted inside the root points wherever it likes, and
 * following one would read a file the caller never had the right to name and
 * echo its content into the report. So the path is confined twice: lexically,
 * and again after every link on it has been followed, against the real path of
 * the root itself — the root may sit behind a link too, as `/var` does on
 * macOS.
 *
 * Without `--root` the operator named the file directly on their own command
 * line, there is no boundary to enforce, and the file is reported by its base
 * name so no host path reaches the report.
 */
export async function resolveInputPath(candidate, rootOption) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError('A trace path is required')
  }

  if (rootOption === null || rootOption === undefined) {
    const absolute = resolve(candidate)
    return { path: absolute, root: dirname(absolute), file: basename(absolute) }
  }

  const root = resolve(rootOption)
  const realRoot = await realPathOf(root, `the input root ("${rootOption}")`)
  if (isAbsolute(candidate)) {
    throw new ConfigError(
      `The trace path must be relative to the input root, but "${candidate}" is absolute`,
      'input-not-relative',
    )
  }
  const absolute = resolve(root, candidate)
  if (escapes(root, absolute)) {
    throw new ConfigError(
      `The trace path resolves outside the input root: "${candidate}"`,
      'input-outside-root',
    )
  }
  const real = await realPathOf(absolute, `the trace path ("${candidate}")`)
  if (escapes(realRoot, real)) {
    throw new ConfigError(
      `The trace path leaves the input root through a symbolic link: "${candidate}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return { path: absolute, root, file: toPosix(relative(root, absolute)) }
}
