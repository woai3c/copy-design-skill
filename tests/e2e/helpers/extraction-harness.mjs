import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export function inventory(directory) {
  if (!fs.existsSync(directory)) return null
  const entries = {}
  function visit(current, prefix) {
    for (const item of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const key = prefix + item.name
      const target = path.join(current, item.name)
      entries[key] = item.isDirectory()
        ? 'directory'
        : createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      if (item.isDirectory()) visit(target, key + '/')
    }
  }
  visit(directory, '')
  return entries
}

export function extractionSandbox(seeded = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'imprint-output-test-'))
  const cwd = path.join(root, 'cwd')
  const home = path.join(root, 'home')
  const temp = path.join(root, 'temp')
  for (const directory of [cwd, home, temp]) fs.mkdirSync(directory)
  const profile = path.join(home, '.imprint')
  if (seeded) {
    fs.mkdirSync(profile)
    fs.writeFileSync(path.join(profile, 'sentinel'), 'Existing user data must survive unchanged.')
  }
  const before = inventory(profile)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  }
  fs.mkdirSync(env.APPDATA, { recursive: true })
  fs.mkdirSync(env.LOCALAPPDATA, { recursive: true })
  const probe = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import os from 'node:os'; process.stdout.write(JSON.stringify([os.homedir(),os.tmpdir()]))",
    ],
    { env, encoding: 'utf8' },
  )
  assert.equal(probe.status, 0, probe.stderr)
  assert.deepEqual(
    JSON.parse(probe.stdout).map((entry) => path.resolve(entry)),
    [home, temp],
  )
  return {
    root,
    cwd,
    home,
    temp,
    profile,
    env,
    verify() {
      assert.deepEqual(inventory(cwd), {}, 'default extraction changed the working directory')
      assert.deepEqual(inventory(profile), before, 'default extraction touched the persistent profile')
      assert.deepEqual(inventory(temp), {}, 'product must clean temporary data before test teardown')
    },
    cleanup() {
      // Only this exact mkdtemp directory belongs to the test.
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    },
  }
}

export async function extractionFixture() {
  let slowRequests = 0
  const waiting = []
  const server = http.createServer((request, response) => {
    if (request.url === '/slow') {
      slowRequests += 1
      for (const notify of waiting.splice(0)) notify()
      response.writeHead(200, { 'content-type': 'text/html' })
      response.write('<html><body>')
      return
    }
    const alternate = request.url?.startsWith('/workspace')
    const primary = alternate ? '#b45309' : '#2563eb'
    const content = alternate
      ? '<aside><h2>Workspace</h2><p>Account settings</p></aside><main><h1>Preferences</h1><form><label>Display name<input value="Example"></label><button type="button">Save preferences</button></form></main>'
      : '<header><nav aria-label="Main">Product navigation</nav></header><main><section><h1>Build useful things</h1><p>Clear interfaces for everyday work.</p><button type="button">Continue</button></section><section><h2>Features</h2><article><h3>Simple tools</h3><p>Consistent spacing and readable type.</p></article></section></main>'
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html><html><head><title>Neutral ${alternate ? 'workspace' : 'landing'}</title><style>
      :root{--brand:${primary};color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f8fafc;color:#172033;font:16px/1.5 Arial,sans-serif}
      header,aside{padding:24px;background:#e2e8f0}main{max-width:960px;padding:32px;margin:auto}section,article,form{padding:16px;margin-bottom:24px}
      h1{font-size:40px;line-height:1.2}h2{font-size:24px}button{color:#fff;background:var(--brand);border:0;border-radius:8px;padding:8px 16px;font:inherit}
      button:hover{filter:brightness(.9)}input{display:block;padding:8px;margin:16px 0;border:1px solid #64748b}
      @media(max-width:700px){main{padding:16px}h1{font-size:32px}}@media(prefers-color-scheme:dark){body{background:#172033;color:#f8fafc}}
      </style></head><body>${content}${request.url === '/blocked' ? '<div role="dialog" aria-modal="true" style="position:fixed;inset:0;background:#ff00ff;z-index:999;display:grid;place-items:center"><h2>Blocking promotion</h2></div>' : ''}</body></html>`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    waitForSlow: (count = 1) =>
      slowRequests >= count ? Promise.resolve() : new Promise((resolve) => waiting.push(resolve)),
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
