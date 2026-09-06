import fs from 'node:fs'
import path from 'node:path'

import type { AnalysisArtifactBundle } from './analysis-artifacts.js'
import { type AnalysisViewport, createAnalysisRequest } from './analyzer/analysis-request.js'
import { coreT } from './i18n/index.js'

export const EXTRACTION_FORMATS = {
  'design.md': { filename: 'DESIGN.md', mimeType: 'text/markdown', field: 'designDoc' },
  css: { filename: 'variables.css', mimeType: 'text/css', field: 'cssVariables' },
  tailwind: { filename: 'theme.css', mimeType: 'text/css', field: 'tailwindTheme' },
  json: { filename: 'design-tokens.json', mimeType: 'application/json', field: 'dtcgJson' },
  scss: { filename: 'variables.scss', mimeType: 'text/plain', field: 'scssVariables' },
  evidence: { filename: 'design-evidence.json', mimeType: 'application/json', field: 'evidenceJson' },
  profile: { filename: 'design-profile.json', mimeType: 'application/json', field: 'profileJson' },
  components: { filename: 'component-specs.json', mimeType: 'application/json', field: 'componentSpecsJson' },
  'visual-qa': { filename: 'visual-qa.json', mimeType: 'application/json', field: 'visualQaJson' },
  html: { filename: 'style-guide.html', mimeType: 'text/html', field: 'pdfHtml' },
} as const satisfies Record<string, { filename: string; mimeType: string; field: keyof AnalysisArtifactBundle }>

export type ArtifactFormat = keyof typeof EXTRACTION_FORMATS
const aliases: Record<string, ArtifactFormat> = { markdown: 'design.md', 'component-specs': 'components', pdf: 'html' }
export const EXTRACTION_FORMAT_NAMES = [...Object.keys(EXTRACTION_FORMATS), ...Object.keys(aliases), 'all', 'tokens']

export class ExtractionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly detail = '',
  ) {
    super(coreT('en', `extraction.errors.${code}`, { value: detail }))
    this.name = 'ExtractionRequestError'
  }
}

export interface ExtractionOptions {
  format: ArtifactFormat | 'all' | 'tokens'
  output?: string
  overwrite: boolean
  viewports: AnalysisViewport[]
  useSession: boolean
  darkMode: boolean
  jsonStdout: boolean
  maxPages: number
  pageDiscovery: 'auto' | 'links' | 'sitemap'
  browserPath?: string
  deprecatedPdf: boolean
}

export interface ExtractionRequest {
  url: string
  options: ExtractionOptions
}

export function normalizeExtractionFormat(value: unknown): ExtractionOptions['format'] {
  if (typeof value !== 'string' || !EXTRACTION_FORMAT_NAMES.includes(value)) {
    throw new ExtractionRequestError('invalid-format', String(value))
  }
  return Object.hasOwn(aliases, value) ? aliases[value] : (value as ExtractionOptions['format'])
}

export function selectedFormats(format: ExtractionOptions['format']): ArtifactFormat[] {
  if (format === 'tokens') return []
  return format === 'all' ? (Object.keys(EXTRACTION_FORMATS) as ArtifactFormat[]) : [format]
}

/** Validate both automation entry points before allocating runtime storage or launching a browser. */
export function createExtractionRequest(input: Record<string, unknown>, transport: 'cli' | 'mcp'): ExtractionRequest {
  const allowed = [
    'url',
    'format',
    'outputDir',
    'overwrite',
    'viewport',
    'useSession',
    'darkMode',
    'maxPages',
    'discovery',
    'browserPath',
  ]
  if (transport === 'cli') allowed.push('jsonStdout')
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ExtractionRequestError('unknown-parameter', key)
  }
  if (typeof input.url !== 'string') throw new ExtractionRequestError('invalid-url')
  const format = normalizeExtractionFormat(input.format === undefined ? 'design.md' : input.format)
  for (const key of ['overwrite', 'useSession', 'darkMode', 'jsonStdout']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean')
      throw new ExtractionRequestError('invalid-parameter', key)
  }
  const viewport = input.viewport === undefined ? 'desktop' : input.viewport
  if (typeof viewport !== 'string' || !['desktop', 'tablet', 'mobile', 'all'].includes(viewport)) {
    throw new ExtractionRequestError('invalid-viewports', String(viewport))
  }
  if (
    input.maxPages !== undefined &&
    (!Number.isSafeInteger(input.maxPages) || Number(input.maxPages) < 1 || Number(input.maxPages) > 20)
  ) {
    throw new ExtractionRequestError('invalid-page-count')
  }
  const discovery = input.discovery === undefined ? 'auto' : input.discovery
  if (typeof discovery !== 'string' || !['auto', 'links', 'sitemap'].includes(discovery)) {
    throw new ExtractionRequestError('invalid-page-discovery', String(discovery))
  }
  if (input.browserPath !== undefined && (typeof input.browserPath !== 'string' || !input.browserPath.trim())) {
    throw new ExtractionRequestError('invalid-parameter', 'browserPath')
  }
  let output: string | undefined
  if (input.outputDir !== undefined) {
    if (typeof input.outputDir !== 'string' || !input.outputDir.trim() || input.outputDir.includes('\0')) {
      throw new ExtractionRequestError('invalid-output', String(input.outputDir))
    }
    if (transport === 'mcp' && !path.isAbsolute(input.outputDir)) throw new ExtractionRequestError('absolute-output')
    output = path.resolve(input.outputDir)
    // Check ancestors as well, so an existing file cannot be treated as a parent directory.
    for (let ancestor = output; ; ancestor = path.dirname(ancestor)) {
      if (fs.existsSync(ancestor)) {
        if (!fs.statSync(ancestor).isDirectory()) throw new ExtractionRequestError('invalid-output', output)
        break
      }
      if (path.dirname(ancestor) === ancestor) break
    }
  }
  if (input.overwrite === true && !output) throw new ExtractionRequestError('overwrite-output')
  const jsonStdout = input.jsonStdout === true
  if ((format === 'tokens' || jsonStdout) && output) throw new ExtractionRequestError('legacy-output')
  if (jsonStdout && input.format !== undefined && input.format !== 'json')
    throw new ExtractionRequestError('legacy-format')
  let url: string
  try {
    url = createAnalysisRequest({ url: input.url }).url
  } catch {
    throw new ExtractionRequestError('invalid-url')
  }
  return {
    url,
    options: {
      format,
      output,
      overwrite: input.overwrite === true,
      viewports: (viewport === 'all' ? ['desktop', 'tablet', 'mobile'] : [viewport]) as AnalysisViewport[],
      useSession: input.useSession === true,
      darkMode: input.darkMode === true,
      jsonStdout,
      maxPages: input.maxPages === undefined ? 8 : (input.maxPages as number),
      pageDiscovery: discovery as ExtractionOptions['pageDiscovery'],
      browserPath: input.browserPath as string | undefined,
      deprecatedPdf: input.format === 'pdf',
    },
  }
}
