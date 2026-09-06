import { normalizeExtractionFormat, selectedFormats } from '../core/extraction-request.js'

export interface CliExportAvailability {
  hasProfile: boolean
}

export function resolveCliExportFormats(format: string, availability: CliExportAvailability): string[] {
  return selectedFormats(normalizeExtractionFormat(format)).filter(
    (item) => item !== 'profile' || availability.hasProfile,
  )
}
