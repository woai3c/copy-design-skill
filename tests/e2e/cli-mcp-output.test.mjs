import { lint } from '@google/design.md/linter'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { compile } from 'tailwindcss'
import { parse } from 'yaml'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { findBrowser } from '../../dist/core/analyzer/browser-finder.js'
import { extractionFixture, extractionSandbox, inventory } from './helpers/extraction-harness.mjs'

const cliPath = path.resolve('dist/cli/index.js')
const mcpPath = path.resolve('dist/mcp/server.js')
const browserPath = findBrowser()
const filenames = {
  'design.md': 'DESIGN.md',
  css: 'variables.css',
  tailwind: 'theme.css',
  json: 'design-tokens.json',
  scss: 'variables.scss',
  evidence: 'design-evidence.json',
  profile: 'design-profile.json',
  components: 'component-specs.json',
  'visual-qa': 'visual-qa.json',
  html: 'style-guide.html',
}

function setup(t, seeded = false) {
  const sandbox = extractionSandbox(seeded)
  sandbox.closers = []
  t.after(async () => {
    for (const close of sandbox.closers) await close()
    sandbox.cleanup()
  })
  return sandbox
}

function cli(sandbox, args) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: sandbox.cwd,
    env: sandbox.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '',
    stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (value) => (stdout += value))
  child.stderr.on('data', (value) => (stderr += value))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('CLI timed out: ' + stderr))
    }, 110_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

async function mcp(t, sandbox) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    cwd: sandbox.cwd,
    env: sandbox.env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'imprint-output-verification', version: '1.0.0' })
  sandbox.closers.push(() => client.close())
  await client.connect(transport)
  return client
}

async function assertArtifact(format, text) {
  assert.equal(typeof text, 'string')
  assert.ok(text.endsWith('\n'))
  assert.doesNotMatch(text, /\[imprint\]|^Analyzing |^Done\.$/m)
  if (format === 'design.md') {
    assert.match(text, /^---\n/)
    assert.match(text, /^# Design System$/m)
    const metadata = parse(text.split('\n---\n')[0].slice(4))
    assert.equal(metadata.version, 'alpha')
    assert.ok(metadata.typography)
    assert.match(JSON.stringify(metadata.typography), /Arial/)
    assert.match(metadata.typography['size-base'].fontSize, /^(16px|1rem)$/)
    const report = lint(text)
    assert.equal(report.summary.errors, 0, JSON.stringify(report.findings))
  } else if (format === 'css' || format === 'tailwind') {
    assert.match(text, format === 'css' ? /:root\s*\{/ : /@theme\s*\{/)
    assert.match(text, /--[a-z][\w-]*\s*:/)
    await compile(text)
  } else if (format === 'scss') {
    assert.match(text, /\$[\w-]+\s*:/)
  } else if (format === 'html') {
    assert.match(text, /<!doctype html>/i)
    assert.match(text, /<\/html>/i)
  } else {
    const data = JSON.parse(text)
    assert.equal(typeof data, 'object')
    if (format === 'json') {
      assert.match(data.$schema, /design-tokens.github.io/)
      assert.ok(data.color && data.typography && data.spacing)
      assert.equal(data.typography.fontFamilies.$type, 'fontFamily')
      assert.match(JSON.stringify(data.typography.fontFamilies.$value), /Arial/)
      assert.match(JSON.stringify(data), /#f8fafc/i)
      assert.equal(data.colors, undefined)
    }
    if (format === 'evidence') {
      assert.ok(data.pages.length > 0)
      assert.ok(data.pages.some((page) => page.images.length > 0))
      assert.equal(data.source.accessMode, 'anonymous')
    }
  }
}

test(
  'T02/T03 URL-only CLI and MCP return consumable DESIGN.md without retained files',
  { timeout: 180_000 },
  async (t) => {
    assert.ok(browserPath, 'Install Chrome or Edge; browser verification must not silently skip')
    const site = await extractionFixture()
    t.after(() => site.close())
    const sandbox = setup(t, true)
    const output = await cli(sandbox, [site.url])
    assert.equal(output.code, 0, output.stderr)
    await assertArtifact('design.md', output.stdout)
    sandbox.verify()
    const client = await mcp(t, sandbox)
    const tools = await client.listTools()
    const schema = tools.tools.find((tool) => tool.name === 'imprint_extract').inputSchema
    assert.deepEqual(schema.required, ['url'])
    assert.equal(schema.properties.useSession.default, false)
    assert.equal(schema.properties.darkMode.default, false)
    const result = await client.callTool(
      { name: 'imprint_extract', arguments: { url: site.url + '/workspace' } },
      undefined,
      { timeout: 90_000 },
    )
    assert.ok(!result.isError, JSON.stringify(result))
    await assertArtifact('design.md', result.content[0].text)
    assert.equal(result.structuredContent.pageCoverage.analyzed, 1)
    sandbox.verify()
  },
)

test('T04/T05 every single artifact format is valid through both processes', { timeout: 900_000 }, async (t) => {
  const site = await extractionFixture()
  t.after(() => site.close())
  const sandbox = setup(t)
  const client = await mcp(t, sandbox)
  for (const format of Object.keys(filenames)) {
    await t.test(format, async () => {
      const output = await cli(sandbox, ['extract', site.url, '--pages', '1', '--format', format])
      assert.equal(output.code, 0, output.stderr)
      await assertArtifact(format, output.stdout)
      const result = await client.callTool(
        { name: 'imprint_extract', arguments: { url: site.url + '/workspace', maxPages: 1, format } },
        undefined,
        { timeout: 90_000 },
      )
      assert.ok(!result.isError, JSON.stringify(result))
      await assertArtifact(format, result.content[0].text)
      assert.doesNotMatch(
        output.stdout + result.content[0].text,
        new RegExp(sandbox.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      )
      sandbox.verify()
    })
  }
})

test('T06/T07/T08 all returns one envelope or a portable saved artifact directory', { timeout: 180_000 }, async (t) => {
  const site = await extractionFixture()
  t.after(() => site.close())
  const sandbox = setup(t)
  const inline = await cli(sandbox, [site.url, '--pages', '1', '--format', 'all'])
  assert.equal(inline.code, 0, inline.stderr)
  const all = JSON.parse(inline.stdout)
  assert.deepEqual(
    all.artifacts.map((artifact) => artifact.format),
    Object.keys(filenames),
  )
  for (const artifact of all.artifacts) {
    await assertArtifact(artifact.format, artifact.content)
    assert.equal(artifact.filename, filenames[artifact.format])
    if (artifact.format === 'evidence') {
      for (const page of JSON.parse(artifact.content).pages)
        for (const image of page.images) {
          assert.equal(image.path, '')
          assert.equal(image.fileAvailability, 'not-retained')
        }
    }
  }
  sandbox.verify()
  const client = await mcp(t, sandbox)
  const collection = await client.callTool(
    { name: 'imprint_extract', arguments: { url: site.url, format: 'all', maxPages: 1 } },
    undefined,
    { timeout: 90_000 },
  )
  assert.ok(!collection.isError, JSON.stringify(collection))
  assert.deepEqual(JSON.parse(collection.content[0].text), collection.structuredContent)
  assert.equal(collection.structuredContent.artifacts.length, 10)
  const profile = JSON.parse(collection.structuredContent.artifacts.find((item) => item.format === 'profile').content)
  const comparison = await client.callTool({
    name: 'imprint_compare',
    arguments: { profileA: profile, profileB: profile },
  })
  assert.ok(!comparison.isError, JSON.stringify(comparison))
  const compared = JSON.parse(comparison.content[0].text)
  assert.equal(compared.thesisSimilarity, 1)
  assert.deepEqual(compared.distinctiveToA, [])
  assert.deepEqual(compared.distinctiveToB, [])
  sandbox.verify()
  const output = path.join(sandbox.root, 'save-all')
  const result = await client.callTool(
    { name: 'imprint_extract', arguments: { url: site.url, format: 'all', maxPages: 1, outputDir: output } },
    undefined,
    { timeout: 90_000 },
  )
  assert.ok(!result.isError, JSON.stringify(result))
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
  assert.equal(result.structuredContent.saved, true)
  assert.equal(result.structuredContent.artifacts.length, 10)
  assert.ok(result.structuredContent.assets.length > 0)
  for (const artifact of result.structuredContent.artifacts) {
    assert.equal(path.dirname(artifact.path), output)
    await assertArtifact(artifact.format, fs.readFileSync(artifact.path, 'utf8'))
  }
  const moved = path.join(sandbox.root, 'moved')
  fs.renameSync(output, moved)
  const evidence = JSON.parse(fs.readFileSync(path.join(moved, 'design-evidence.json'), 'utf8'))
  for (const page of evidence.pages)
    for (const image of page.images) {
      assert.ok(!path.isAbsolute(image.path))
      assert.ok(fs.existsSync(path.join(moved, image.path)))
    }
  sandbox.verify()
})

test(
  'T07/T09 CLI save defaults, relative directories, selected overwrite and aliases',
  { timeout: 240_000 },
  async (t) => {
    const site = await extractionFixture()
    t.after(() => site.close())
    const sandbox = setup(t)
    // A relative path is resolved against the child cwd; it deliberately points outside measured cwd.
    let output = await cli(sandbox, [site.url, '--pages', '1', '--output', '../saved'])
    assert.equal(output.code, 0, output.stderr)
    assert.equal(output.stdout, '')
    const directory = path.join(sandbox.root, 'saved')
    assert.deepEqual(fs.readdirSync(directory), ['DESIGN.md'])
    const before = inventory(directory)
    output = await cli(sandbox, [site.url, '--output', '../saved'])
    assert.equal(output.code, 4)
    assert.equal(output.stdout, '')
    assert.doesNotMatch(output.stderr, /headless browser resolved/)
    assert.deepEqual(inventory(directory), before)
    fs.writeFileSync(path.join(directory, 'unrelated'), 'preserve')
    output = await cli(sandbox, [
      site.url,
      '--pages',
      '1',
      '--format',
      'markdown',
      '--output',
      '../saved',
      '--overwrite',
    ])
    assert.equal(output.code, 0, output.stderr)
    assert.equal(fs.readFileSync(path.join(directory, 'unrelated'), 'utf8'), 'preserve')
    output = await cli(sandbox, [site.url, '--pages', '1', '--format', 'css', '--output', '../css-only'])
    assert.equal(output.code, 0, output.stderr)
    assert.deepEqual(fs.readdirSync(path.join(sandbox.root, 'css-only')), ['variables.css'])
    output = await cli(sandbox, [site.url, '--pages', '1', '--format', 'pdf'])
    assert.equal(output.code, 0, output.stderr)
    assert.match(output.stderr, /HTML/)
    await assertArtifact('html', output.stdout)
    sandbox.verify()
  },
)

test('T07/T09 MCP selected saves and overwrite, plus CLI all save', { timeout: 180_000 }, async (t) => {
  const site = await extractionFixture()
  t.after(() => site.close())
  const sandbox = setup(t, true)
  const client = await mcp(t, sandbox)
  const output = path.join(sandbox.root, 'mcp-selected')
  for (const format of [undefined, 'css']) {
    const result = await client.callTool(
      {
        name: 'imprint_extract',
        arguments: { url: site.url, maxPages: 1, outputDir: output, ...(format ? { format } : {}) },
      },
      undefined,
      { timeout: 90_000 },
    )
    assert.ok(!result.isError, JSON.stringify(result))
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent)
    assert.equal(result.structuredContent.artifacts.length, 1)
    const artifact = result.structuredContent.artifacts[0]
    assert.equal(artifact.filename, filenames[format || 'design.md'])
    assert.equal(artifact.path, path.join(output, artifact.filename))
    await assertArtifact(format || 'design.md', fs.readFileSync(artifact.path, 'utf8'))
    sandbox.verify()
  }
  assert.deepEqual(fs.readdirSync(output).sort(), ['DESIGN.md', 'variables.css'])
  fs.writeFileSync(path.join(output, 'unrelated'), 'keep')
  const before = inventory(output)
  const collision = await client.callTool({
    name: 'imprint_extract',
    arguments: { url: site.url, format: 'css', outputDir: output },
  })
  assert.equal(collision.isError, true)
  assert.deepEqual(inventory(output), before)
  const overwritten = await client.callTool(
    {
      name: 'imprint_extract',
      arguments: { url: site.url + '/workspace', maxPages: 1, format: 'css', outputDir: output, overwrite: true },
    },
    undefined,
    { timeout: 90_000 },
  )
  assert.ok(!overwritten.isError, JSON.stringify(overwritten))
  assert.equal(fs.readFileSync(path.join(output, 'unrelated'), 'utf8'), 'keep')
  assert.equal(inventory(output)['DESIGN.md'], before['DESIGN.md'])
  assert.match(fs.readFileSync(path.join(output, 'variables.css'), 'utf8'), /#b45309/i)
  const allDirectory = path.join(sandbox.root, 'cli-all')
  const all = await cli(sandbox, [site.url, '--pages', '1', '--format', 'all', '--output', allDirectory])
  assert.equal(all.code, 0, all.stderr)
  assert.equal(all.stdout, '')
  for (const [format, filename] of Object.entries(filenames)) {
    await assertArtifact(format, fs.readFileSync(path.join(allDirectory, filename), 'utf8'))
  }
  assert.deepEqual(fs.readdirSync(allDirectory).sort(), [...Object.values(filenames), 'assets'].sort())
  sandbox.verify()
})

test('T17 MCP URL comparison retains its existing persistent storage contract', { timeout: 180_000 }, async (t) => {
  const first = await extractionFixture()
  const second = await extractionFixture()
  t.after(() => first.close())
  t.after(() => second.close())
  const sandbox = setup(t, true)
  const client = await mcp(t, sandbox)
  const result = await client.callTool(
    { name: 'imprint_compare', arguments: { urlA: first.url, urlB: second.url + '/workspace' } },
    undefined,
    { timeout: 150_000 },
  )
  assert.ok(!result.isError, JSON.stringify(result))
  const comparison = JSON.parse(result.content[0].text)
  assert.ok(comparison.colors.changed.length > 0)
  assert.match(JSON.stringify(comparison.colors), /#2563eb/i)
  assert.match(JSON.stringify(comparison.colors), /#b45309/i)
  assert.equal(comparison.typography.fontFamiliesChanged, false)
  assert.equal(
    fs.readFileSync(path.join(sandbox.profile, 'sentinel'), 'utf8'),
    'Existing user data must survive unchanged.',
  )
  assert.ok(fs.readdirSync(path.join(sandbox.profile, 'screenshots')).length > 0)
  assert.deepEqual(inventory(sandbox.cwd), {})
  assert.deepEqual(inventory(sandbox.temp), {})
})

test('T10 invalid parameter combinations fail before analysis or file creation', { timeout: 60_000 }, async (t) => {
  const sandbox = setup(t, true)
  const destination = path.join(sandbox.root, 'unexpected')
  for (const args of [
    ['extract'],
    ['file:///invalid'],
    ['https://example.test', '--format', 'invalid'],
    ['https://example.test', '--pages', '21'],
    ['https://example.test', '--viewport', 'invalid'],
    ['https://example.test', '--use-session', '--no-session'],
    ['https://example.test', '--overwrite'],
    ['https://example.test', '--json-stdout', '--output', destination],
  ]) {
    const result = await cli(sandbox, args)
    assert.equal(result.code, 2, result.stderr)
    assert.equal(result.stdout, '')
    assert.doesNotMatch(result.stderr, /headless browser resolved/)
  }
  const client = await mcp(t, sandbox)
  for (const args of [
    {},
    { url: 42 },
    { url: 'file:///invalid' },
    { url: 'https://example.test', format: 'invalid', outputDir: destination },
    { url: 'https://example.test', maxPages: '1' },
    { url: 'https://example.test', useSession: 'false' },
    { url: 'https://example.test', format: 'tokens', outputDir: destination },
    { url: 'https://example.test', outputDir: './relative' },
    { url: 'https://example.test', viewport: ['desktop'] },
  ]) {
    const result = await client.callTool({ name: 'imprint_extract', arguments: args })
    assert.equal(result.isError, true, JSON.stringify(result))
  }
  assert.equal(fs.existsSync(destination), false)
  sandbox.verify()
})

test('T11 browser and capture failures leave no success output or retained data', { timeout: 180_000 }, async (t) => {
  const site = await extractionFixture()
  t.after(() => site.close())
  const sandbox = setup(t, true)
  const startup = await cli(sandbox, [site.url, '--browser-path', path.join(sandbox.root, 'missing-browser')])
  assert.equal(startup.code, 3, startup.stderr)
  assert.equal(startup.stdout, '')
  sandbox.verify()
  const blocked = await cli(sandbox, [site.url + '/blocked', '--pages', '1', '--quiet'])
  assert.equal(blocked.code, 4, blocked.stderr)
  assert.equal(blocked.stdout, '')
  assert.match(blocked.stderr, /health:large-overlay/)
  sandbox.verify()
})

test(
  'T13/T15/T16 optional observation parameters, sessions and concurrent requests',
  { timeout: 240_000 },
  async (t) => {
    const site = await extractionFixture()
    t.after(() => site.close())
    const sandbox = setup(t, true)
    const client = await mcp(t, sandbox)
    const results = await Promise.all([
      client.callTool(
        {
          name: 'imprint_extract',
          arguments: {
            url: site.url,
            format: 'evidence',
            maxPages: 1,
            viewport: 'mobile',
            discovery: 'links',
            browserPath,
            darkMode: true,
          },
        },
        undefined,
        { timeout: 90_000 },
      ),
      client.callTool(
        { name: 'imprint_extract', arguments: { url: site.url + '/workspace', format: 'json', maxPages: 1 } },
        undefined,
        { timeout: 90_000 },
      ),
    ])
    for (const result of results) assert.ok(!result.isError, JSON.stringify(result))
    const evidence = JSON.parse(results[0].content[0].text)
    assert.ok(evidence.pages.some((page) => page.viewport === 'mobile'))
    assert.equal(evidence.source.accessMode, 'anonymous')
    assert.match(results[1].content[0].text, /#b45309/i)
    sandbox.verify()
    const allViewports = await cli(sandbox, [
      site.url,
      '--format',
      'evidence',
      '--pages',
      '1',
      '--viewport',
      'all',
      '--discovery',
      'sitemap',
      '--dark-mode',
      '--no-session',
      '--quiet',
    ])
    assert.equal(allViewports.code, 0, allViewports.stderr)
    const viewports = new Set(JSON.parse(allViewports.stdout).pages.map((page) => page.viewport))
    for (const viewport of ['desktop', 'tablet', 'mobile']) assert.ok(viewports.has(viewport))
    sandbox.verify()
    const session = await cli(sandbox, [site.url, '--pages', '1', '--use-session'])
    assert.equal(session.code, 0, session.stderr)
    assert.match(session.stderr, /persistent Imprint browser profiles/)
    assert.ok(fs.existsSync(path.join(sandbox.profile, 'browser-profiles')))
    assert.equal(
      fs.readFileSync(path.join(sandbox.profile, 'sentinel'), 'utf8'),
      'Existing user data must survive unchanged.',
    )
    assert.deepEqual(inventory(sandbox.temp), {})
    assert.deepEqual(inventory(sandbox.cwd), {})
  },
)

test(
  'T12/T13 MCP cancellation and graceful transport close clean active work independently',
  { timeout: 120_000 },
  async (t) => {
    const site = await extractionFixture()
    t.after(() => site.close())
    const sandbox = setup(t)
    const client = await mcp(t, sandbox)
    const controller = new AbortController()
    const slow = client.callTool(
      { name: 'imprint_extract', arguments: { url: site.url + '/slow', maxPages: 1 } },
      undefined,
      { signal: controller.signal, timeout: 90_000 },
    )
    const cancelled = assert.rejects(slow, /cancel|abort/i)
    const fast = client.callTool(
      { name: 'imprint_extract', arguments: { url: site.url + '/workspace', maxPages: 1 } },
      undefined,
      { timeout: 90_000 },
    )
    await site.waitForSlow()
    assert.ok(fs.readdirSync(sandbox.temp).filter((name) => name.startsWith('imprint-extract-')).length >= 1)
    controller.abort(new Error('cancel active extraction'))
    await cancelled
    const result = await fast
    assert.ok(!result.isError, JSON.stringify(result))
    await assertArtifact('design.md', result.content[0].text)
    const deadline = Date.now() + 10_000
    while (fs.readdirSync(sandbox.temp).length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25))
    sandbox.verify()
    const closing = client.callTool(
      { name: 'imprint_extract', arguments: { url: site.url + '/slow', maxPages: 1 } },
      undefined,
      { timeout: 90_000 },
    )
    const disconnected = assert.rejects(closing, /closed|cancel/i)
    await site.waitForSlow(2)
    await client.close()
    await disconnected
    sandbox.verify()
  },
)
