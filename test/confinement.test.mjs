import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

import { ConfigError, mapTrace } from '../src/index.mjs'

const run = promisify(execFile)
const projectDirectory = resolve(fileURLToPath(new URL('..', import.meta.url)))
const cli = join(projectDirectory, 'bin/redirect-chain-mapper.mjs')

/**
 * A string that exists only in the file outside the declared root. If any part
 * of the tool ever follows a link out of the tree, this marker is what the
 * report would carry — so asserting its absence from the whole serialized
 * output is a real check, not a restatement of the refusal.
 */
const MARKER = 'out-of-root-marker-4f1c'

/**
 * root/
 *   inside.json            a perfectly ordinary trace
 *   link.json           -> ../outside/leaked.json
 *   linked-directory    -> ../outside
 * outside/
 *   leaked.json            a valid trace naming MARKER
 */
async function plantedTree() {
  const base = await mkdtemp(join(tmpdir(), 'redirect-chain-mapper-confinement-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(outside)

  await writeFile(
    join(root, 'inside.json'),
    JSON.stringify({
      requests: [
        { url: 'https://inside.example.com/a', status: 301, location: '/b' },
        { url: 'https://inside.example.com/b', status: 200 },
      ],
    }),
  )
  await writeFile(
    join(outside, 'leaked.json'),
    JSON.stringify({ requests: [{ url: `https://${MARKER}.example.net/secret`, status: 200 }] }),
  )
  await symlink(join(outside, 'leaked.json'), join(root, 'link.json'))
  await symlink(outside, join(root, 'linked-directory'))
  return { base, root, outside }
}

test('a trace inside the declared root is read normally', async () => {
  const { root } = await plantedTree()
  const { report, file } = await mapTrace({ trace: 'inside.json', root })
  assert.equal(file, 'inside.json')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
  // Without this control, every assertion below could pass because the tool
  // refuses everything.
  assert.deepEqual(
    report.findings.map((finding) => finding.ruleId),
    ['chain-mapped'],
  )
})

test('a symbolic link to a file outside the root is refused, and nothing is read through it', async () => {
  const { root } = await plantedTree()
  await assert.rejects(
    () => mapTrace({ trace: 'link.json', root }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.rule, 'input-escapes-root')
      assert.ok(!error.message.includes(MARKER))
      return true
    },
  )
})

test('a symbolic link that stays inside the root is followed, so the check is the target not the link', async () => {
  const { root } = await plantedTree()
  await symlink(join(root, 'inside.json'), join(root, 'alias.json'))
  const { report, file } = await mapTrace({ trace: 'alias.json', root })
  assert.equal(file, 'alias.json')
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.checked, 1)
})

test('a symbolic link to a directory outside the root is refused', async () => {
  const { root } = await plantedTree()
  await assert.rejects(
    () => mapTrace({ trace: 'linked-directory/leaked.json', root }),
    (error) => {
      assert.ok(error instanceof ConfigError)
      assert.equal(error.rule, 'input-escapes-root')
      return true
    },
  )
})

test('a lexical escape and an absolute path are refused before anything is opened', async () => {
  const { root } = await plantedTree()
  await assert.rejects(() => mapTrace({ trace: '../outside/leaked.json', root }), {
    name: 'ConfigError',
    rule: 'input-outside-root',
  })
  await assert.rejects(() => mapTrace({ trace: join(root, 'inside.json'), root }), {
    name: 'ConfigError',
    rule: 'input-not-relative',
  })
})

test('no out-of-root content reaches stdout or stderr when a planted link is refused', async () => {
  const { root } = await plantedTree()
  for (const candidate of ['link.json', 'linked-directory/leaked.json']) {
    const result = await run(process.execPath, [cli, '--trace', candidate, '--root', root], {
      encoding: 'utf8',
    }).catch((error) => error)

    assert.equal(result.code, 2, `${candidate} must exit 2`)
    // A configuration error means the run never had a subject, so there is
    // nothing to report about and stdout stays empty.
    assert.equal(result.stdout, '')
    assert.ok(!result.stdout.includes(MARKER))
    assert.ok(!result.stderr.includes(MARKER), `${candidate} leaked out-of-root content to stderr`)
    assert.match(result.stderr, /leaves the input root through a symbolic link/)
  }
})

test('with --root, the report names the trace by its path inside the root, never by a host path', async () => {
  const { root } = await plantedTree()
  await mkdir(join(root, 'captures'))
  await writeFile(
    join(root, 'captures', 'one.json'),
    JSON.stringify({ requests: [{ url: 'https://example.com/a', status: 200 }] }),
  )
  const { report, file } = await mapTrace({ trace: 'captures/one.json', root })
  assert.equal(file, 'captures/one.json')
  assert.equal(report.findings[0].location.file, 'captures/one.json')
  assert.ok(!JSON.stringify(report).includes(tmpdir()))
})
