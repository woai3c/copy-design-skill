import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { parseCliCommand } from '../../src/cli/command.js'
import { buildAnalysisArtifacts } from '../../src/core/analysis-artifacts.js'
import { analyze } from '../../src/core/analyzer/index.js'
import type { AnalysisOptions, AnalysisResult, DesignToken } from '../../src/core/analyzer/types.js'
import * as dataDirectory from '../../src/core/data-dir.js'
import type { DesignEvidence } from '../../src/core/design-evidence/types.js'
import { runExtraction } from '../../src/core/extraction-delivery.js'
import { createExtractionRequest } from '../../src/core/extraction-request.js'

vi.mock('../../src/core/analyzer/index.js', async (original) => ({
  ...(await original<typeof import('../../src/core/analyzer/index.js')>()),
  analyze: vi.fn(),
}))

const url = 'https://example.test/'
const formats = [
  'design.md',
  'css',
  'tailwind',
  'json',
  'scss',
  'evidence',
  'profile',
  'components',
  'visual-qa',
  'html',
]
let root: string
let workspaces: string[]

function fixture(options: AnalysisOptions): AnalysisResult {
  const capture = path.join(options.dataDir, 'screenshots', 'capture.png')
  fs.mkdirSync(path.dirname(capture), { recursive: true })
  fs.writeFileSync(capture, 'fixture pixels')
  const tokens: DesignToken = {
    colors: { background: '#ffffff', foreground: '#111827', primary: '#2563eb' },
    typography: {
      fontFamilies: ['Arial'],
      fontStacks: ['Arial, sans-serif'],
      fontSizes: ['16px'],
      fontWeights: ['400'],
      lineHeights: ['1.5'],
      letterSpacings: [],
    },
    spacing: ['16px'],
    radii: ['8px'],
    shadows: [],
    borders: [],
    zIndices: [],
    transitions: [],
  }
  const evidence: DesignEvidence = {
    schemaVersion: '1',
    analysisId: 'fixture',
    source: { requestedUrl: url, finalUrl: url, accessMode: 'anonymous', language: 'en' },
    pages: [
      {
        id: 'p1',
        url,
        viewport: 'desktop',
        images: [{ id: 'image1', kind: 'overview', path: capture, width: 800, height: 600 }],
      },
    ],
    tokens,
    topology: {
      schemaVersion: '1',
      pages: [{ pageId: 'p1', role: 'landing', sectionIds: [] }],
      globalLayers: [],
      crossPagePatternIds: [],
    },
    featureTags: [],
    sections: [],
    components: [],
    layoutNodes: [],
    interactionStyles: { hover: [], focus: [], active: [] },
    interactionObservations: [],
    breakpoints: [],
    responsiveObservations: [],
    motion: [],
    mediaLayers: [],
    coverage: {
      pageCoverage: 'complete',
      sectionCoverage: 0,
      viewportCoverage: ['desktop'],
      interactionCoverage: { candidates: 0, safelyObserved: 0, skipped: 0 },
      mediaCoverage: { majorRegions: 0, classifiedRegions: 0, iconRegions: 0 },
      accessRestrictions: [],
      limitations: [],
    },
    limitations: [],
  }
  return {
    analysisId: 'fixture',
    tokens,
    designEvidence: evidence,
    darkMode: null,
    featureTags: [],
    components: [],
    breakpoints: [],
    finalUrl: url,
    completion: { reason: 'complete' },
    extractionIssues: [],
    duration: 1,
    timing: { totalMs: 1 },
    pageCoverage: {
      requested: 1,
      discovered: 0,
      selected: 0,
      analyzed: 1,
      pages: [{ url, source: 'requested', kind: 'entry' }],
    },
  } as AnalysisResult
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'imprint-delivery-test-'))
  workspaces = []
  vi.spyOn(os, 'tmpdir').mockReturnValue(root)
  vi.spyOn(dataDirectory, 'getDefaultDataDir').mockImplementation(() => {
    const directory = path.join(root, '.imprint')
    fs.mkdirSync(directory, { recursive: true })
    return directory
  })
  vi.mocked(analyze).mockImplementation(async (_url, options) => {
    workspaces.push(options.dataDir)
    return fixture(options)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(analyze).mockReset()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('shared extraction contract', () => {
  it('normalizes URL-only CLI and MCP identically without persistent-session defaults', () => {
    const cli = parseCliCommand([url])
    const mcp = createExtractionRequest({ url }, 'mcp')
    expect(cli).toMatchObject({ kind: 'extract', ...mcp })
    expect(mcp.options).toMatchObject({
      format: 'design.md',
      output: undefined,
      maxPages: 8,
      viewports: ['desktop'],
      darkMode: false,
      useSession: false,
    })
  })

  it.each([
    {},
    { url: 5 },
    { url: 'file:///page.html' },
    { url, format: null },
    { url, format: 'invalid' },
    { url, maxPages: '2' },
    { url, maxPages: 1.5 },
    { url, maxPages: 21 },
    { url, maxPages: null },
    { url, viewport: [] },
    { url, viewport: null },
    { url, useSession: 'false' },
    { url, darkMode: 0 },
    { url, overwrite: 'true' },
    { url, overwrite: true },
    { url, discovery: 'other' },
    { url, browserPath: 42 },
    { url, outputDir: '' },
    { url, outputDir: './relative' },
    { url, unknown: true },
  ])('rejects malformed MCP parameters before work: %j', (input) => {
    expect(() => createExtractionRequest(input, 'mcp')).toThrow()
    expect(analyze).not.toHaveBeenCalled()
    expect(dataDirectory.getDefaultDataDir).not.toHaveBeenCalled()
    expect(fs.readdirSync(root)).toEqual([])
  })

  it('rejects conflicting CLI and legacy save combinations without creating directories', () => {
    const destination = path.join(root, 'output')
    for (const args of [
      [url, '--use-session', '--no-session'],
      [url, '--format', 'css', '--format', 'json'],
      [url, '--json-stdout', '--format', 'css'],
      [url, '--json-stdout', '--output', destination],
    ])
      expect(() => parseCliCommand(args)).toThrow()
    expect(() => createExtractionRequest({ url, format: 'tokens', outputDir: destination }, 'mcp')).toThrow(
      /inline-only/,
    )
    fs.writeFileSync(path.join(root, 'file'), 'keep')
    expect(() => createExtractionRequest({ url, outputDir: path.join(root, 'file', 'child') }, 'mcp')).toThrow()
    expect(fs.existsSync(destination)).toBe(false)
  })
})

describe('delivery and owned resource lifetime', () => {
  it('returns complete Markdown and retains no files or ordinary data directory', async () => {
    const delivery = await runExtraction(createExtractionRequest({ url }, 'cli'))
    expect(delivery.text).toMatch(/^---\n/)
    expect(delivery.text).toMatch(/^# Design System$/m)
    expect(delivery.text).toContain('Arial')
    expect(delivery.text).toContain('#2563eb')
    expect(delivery.text).not.toContain(root)
    expect(delivery.text.endsWith('\n')).toBe(true)
    expect(fs.readdirSync(root)).toEqual([])
    expect(dataDirectory.getDefaultDataDir).not.toHaveBeenCalled()
    expect(vi.mocked(analyze).mock.calls[0][1]).toMatchObject({ useSession: false, extractDarkMode: false })
  })

  it('builds all ten artifacts once, keeps evidence metadata but marks temporary files unavailable', async () => {
    const delivery = await runExtraction(createExtractionRequest({ url, format: 'all' }, 'mcp'))
    const body = JSON.parse(delivery.text)
    expect(body).toEqual(delivery.structuredContent)
    expect(body.artifacts.map((item: { format: string }) => item.format)).toEqual(formats)
    const byFormat = Object.fromEntries(
      body.artifacts.map((item: { format: string; content: string }) => [item.format, item.content]),
    )
    expect(byFormat.css).toContain('--color-primary: #2563eb')
    expect(byFormat.tailwind).toContain('@theme')
    expect(JSON.parse(byFormat.json).color.primary).toEqual({ $type: 'color', $value: '#2563eb' })
    expect(JSON.parse(byFormat.evidence).pages[0].images[0]).toMatchObject({
      id: 'image1',
      path: '',
      fileAvailability: 'not-retained',
      width: 800,
    })
    expect(byFormat.html).toMatch(/<!DOCTYPE html>/i)
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(root)).toEqual([])
  })

  it.each([
    ['markdown', 'design.md'],
    ['component-specs', 'components'],
    ['pdf', 'html'],
  ])('keeps alias %s equivalent to %s', async (alias, canonical) => {
    const a = await runExtraction(createExtractionRequest({ url, format: alias }, 'mcp'))
    const b = await runExtraction(createExtractionRequest({ url, format: canonical }, 'cli'))
    expect(a.text).toBe(b.text)
    if (alias === 'pdf') expect(a.warnings.join()).toContain('HTML')
  })

  it('preserves legacy token payloads without confusing them with DTCG', async () => {
    const cli = await runExtraction(createExtractionRequest({ url, format: 'json', jsonStdout: true }, 'cli'))
    const mcp = await runExtraction(createExtractionRequest({ url, format: 'tokens' }, 'mcp'))
    expect(JSON.parse(cli.text).colors.primary).toBe('#2563eb')
    expect(JSON.parse(mcp.text).tokens.colors.primary).toBe('#2563eb')
    expect(JSON.parse(mcp.text).completion).toEqual({ reason: 'complete' })
    expect(JSON.parse(cli.text)).not.toHaveProperty('$schema')
  })

  it('shares generated content with the existing Desktop artifact builder', async () => {
    let expected: ReturnType<typeof buildAnalysisArtifacts>
    vi.mocked(analyze).mockImplementationOnce(async (_url, options) => {
      const result = fixture(options)
      expected = buildAnalysisArtifacts(result, { sourceUrl: url })
      return result
    })
    const delivery = await runExtraction(createExtractionRequest({ url, format: 'all' }, 'cli'))
    const artifacts = JSON.parse(delivery.text).artifacts
    for (const [format, field] of [
      ['design.md', 'designDoc'],
      ['css', 'cssVariables'],
      ['tailwind', 'tailwindTheme'],
      ['json', 'dtcgJson'],
    ] as const) {
      expect(artifacts.find((item: { format: string }) => item.format === format).content.trimEnd()).toBe(
        expected![field].trimEnd(),
      )
    }
  })

  it('saves only selected files, prevents collisions, and preserves unrelated files on overwrite', async () => {
    const output = path.join(root, 'saved')
    fs.mkdirSync(output)
    fs.writeFileSync(path.join(output, 'unrelated'), 'keep')
    const request = createExtractionRequest({ url, outputDir: output }, 'mcp')
    const saved = await runExtraction(request)
    expect(saved.saved?.artifacts.map((item) => item.filename)).toEqual(['DESIGN.md'])
    expect(fs.readdirSync(output).sort()).toEqual(['DESIGN.md', 'unrelated'])
    const before = fs.readFileSync(path.join(output, 'DESIGN.md'), 'utf8')
    await expect(runExtraction(request)).rejects.toThrow(/already exists/)
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(path.join(output, 'DESIGN.md'), 'utf8')).toBe(before)
    await runExtraction(createExtractionRequest({ url, outputDir: output, overwrite: true }, 'cli'))
    expect(fs.readFileSync(path.join(output, 'unrelated'), 'utf8')).toBe('keep')
    expect(workspaces.every((workspace) => !fs.existsSync(workspace))).toBe(true)
  })

  it('bundles only referenced captures and survives moving the saved directory', async () => {
    const output = path.join(root, 'saved')
    const delivery = await runExtraction(createExtractionRequest({ url, format: 'all', outputDir: output }, 'mcp'))
    expect(delivery.saved?.artifacts).toHaveLength(10)
    expect(delivery.saved?.assets).toHaveLength(1)
    const moved = path.join(root, 'moved')
    fs.renameSync(output, moved)
    const evidence = JSON.parse(fs.readFileSync(path.join(moved, 'design-evidence.json'), 'utf8'))
    expect(fs.readFileSync(path.join(moved, evidence.pages[0].images[0].path), 'utf8')).toBe('fixture pixels')
    expect(JSON.stringify(evidence)).not.toContain(root)
  })

  it.each([false, true])('rejects dangling output symlinks with overwrite=%s before analysis', async (overwrite) => {
    const output = path.join(root, 'saved')
    const referent = path.join(root, 'outside.css')
    const target = path.join(output, 'variables.css')
    fs.mkdirSync(output)
    // Junctions exercise dangling-link detection on Windows without requiring symlink privileges.
    fs.symlinkSync(referent, target, process.platform === 'win32' ? 'junction' : 'file')
    expect(fs.existsSync(target)).toBe(false)
    await expect(
      runExtraction(createExtractionRequest({ url, format: 'css', outputDir: output, overwrite }, 'cli')),
    ).rejects.toThrow(/cannot be replaced/)
    expect(analyze).not.toHaveBeenCalled()
    expect(fs.existsSync(referent)).toBe(false)
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true)
    expect(fs.readdirSync(root)).toEqual(['saved'])
  })

  it.each(['artifact', 'capture'])(
    'reports the failing %s destination when a write leaves partial bytes',
    async (kind) => {
      const output = path.join(root, 'saved')
      const target = path.join(output, kind === 'artifact' ? 'variables.css' : 'assets/capture.png')
      const originalWrite = fs.writeFileSync
      const originalCopy = fs.copyFileSync
      if (kind === 'artifact') {
        vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
          if (String(file) !== target) return originalWrite(file, ...args)
          originalWrite(file, 'partial bytes')
          throw new Error('disk full after partial write')
        })
      } else {
        vi.spyOn(fs, 'copyFileSync').mockImplementation((source, destination, flags) => {
          if (String(destination) !== target) return originalCopy(source, destination, flags)
          originalWrite(destination, 'partial bytes')
          throw new Error('disk full after partial copy')
        })
      }
      await expect(
        runExtraction(
          createExtractionRequest({ url, format: kind === 'artifact' ? 'css' : 'all', outputDir: output }, 'cli'),
        ),
      ).rejects.toThrow(target)
      expect(fs.readFileSync(target, 'utf8')).toBe('partial bytes')
      expect(fs.readdirSync(root)).toEqual(['saved'])
      expect(workspaces.every((workspace) => !fs.existsSync(workspace))).toBe(true)
    },
  )

  it('only accesses the persistent session directory when explicitly requested', async () => {
    await runExtraction(createExtractionRequest({ url, useSession: true }, 'mcp'))
    expect(dataDirectory.getDefaultDataDir).toHaveBeenCalledTimes(1)
    expect(vi.mocked(analyze).mock.calls[0][1]).toMatchObject({
      sessionDataDir: path.join(root, '.imprint'),
      useSession: true,
    })
    expect(fs.readdirSync(root)).toEqual(['.imprint'])
  })

  it('cleans after an analyzer or export write failure and reports already-written files', async () => {
    vi.mocked(analyze).mockImplementationOnce(async (_url, options) => {
      fixture(options)
      throw new Error('capture failed')
    })
    await expect(runExtraction(createExtractionRequest({ url }, 'cli'))).rejects.toThrow('capture failed')
    expect(fs.readdirSync(root)).toEqual([])
    const original = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (String(file).endsWith('variables.css')) throw new Error('disk full')
      return original(file, ...args)
    })
    const output = path.join(root, 'saved')
    await expect(
      runExtraction(createExtractionRequest({ url, format: 'all', outputDir: output }, 'cli')),
    ).rejects.toThrow(/disk full.*DESIGN.md/)
    expect(fs.existsSync(path.join(output, 'DESIGN.md'))).toBe(true)
    expect(fs.readdirSync(root)).toEqual(['saved'])
  })

  it('fails delivery when cleanup fails and reports the exact owned residual path', async () => {
    vi.spyOn(fs, 'rmSync').mockImplementation(() => {
      throw new Error('locked')
    })
    const diagnostic = vi.fn()
    await expect(runExtraction(createExtractionRequest({ url }, 'cli'), { onDiagnostic: diagnostic })).rejects.toThrow(
      /cleanup failed/,
    )
    expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining(workspaces[0]))
    expect(fs.existsSync(workspaces[0])).toBe(true)
  })

  it('cleans and preserves cancellation rather than returning a completed document', async () => {
    const controller = new AbortController()
    vi.mocked(analyze).mockImplementationOnce(async (_url, options) => {
      const result = fixture(options)
      controller.abort(new DOMException('cancelled', 'AbortError'))
      return result
    })
    await expect(
      runExtraction(createExtractionRequest({ url }, 'cli'), { signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fs.readdirSync(root)).toEqual([])
  })
})
