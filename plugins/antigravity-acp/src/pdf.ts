import type { AcpPromptContent } from './acp-client.js'
import type { PdfEmbeddedImage, PdfTextResult } from './pdf-text.js'

export interface PdfConversionLimits {
  maxPages: number
  maxPageTextChars: number
  maxImages: number
  maxTotalImageBytes: number
}

export interface PdfPageImage {
  png: Uint8Array
  width: number
  height: number
  page?: number
  mimeType?: 'image/png' | 'image/jpeg'
}

export type PdfPageRenderer = (
  pages: readonly number[],
  maxImages: number,
  maxBytes: number,
) => Promise<readonly PdfPageImage[]>

/** Combine extracted text with selective PNG rendering; never emit a PDF path/link or raw PDF bytes. */
export async function pdfPrompt(
  fileName: string,
  extracted: PdfTextResult,
  render: PdfPageRenderer,
  limits: PdfConversionLimits,
  embedded: ReadonlyMap<number, PdfEmbeddedImage> = new Map(),
): Promise<AcpPromptContent[]> {
  const output: AcpPromptContent[] = []
  const wanted = extracted.pages.filter((page) => page.needsImage)
  const requestedPages = wanted.slice(0, limits.maxImages).map((page) => page.page)
  const skippedImages = wanted.slice(limits.maxImages).map((page) => page.page)
  const byPage = new Map<number, PdfPageImage>()
  let renderFailure: string | undefined
  for (const page of requestedPages) {
    const image = embedded.get(page)
    if (image === undefined) continue
    byPage.set(page, {
      png: image.data,
      width: image.width,
      height: image.height,
      page,
      mimeType: image.mimeType,
    })
  }
  const remaining = requestedPages.filter((page) => !byPage.has(page))
  if (remaining.length > 0) {
    try {
      const images = await render(
        remaining,
        remaining.length,
        Math.max(0, limits.maxTotalImageBytes),
      )
      for (const image of images) {
        if (image.page !== undefined && remaining.includes(image.page))
          byPage.set(image.page, image)
      }
      const missing = remaining.filter((page) => !byPage.has(page))
      if (missing.length > 0) skippedImages.push(...missing)
    } catch (error) {
      renderFailure = error instanceof Error ? error.message : String(error)
      skippedImages.push(...remaining)
    }
  }
  let imageBytes = 0
  for (const page of extracted.pages) {
    const image = byPage.get(page.page)
    const label = `[PDF ${fileName} — page ${page.page}/${extracted.totalPages}]`
    if (page.text.trim()) output.push({ type: 'text', text: `${label}\n${page.text}` })
    if (image !== undefined && imageBytes + image.png.byteLength <= limits.maxTotalImageBytes) {
      imageBytes += image.png.byteLength
      const mimeType = image.mimeType ?? 'image/png'
      output.push({
        type: 'text',
        text: `${label} page image (${image.width}×${image.height}, ${mimeType === 'image/jpeg' ? 'embedded scan JPEG' : 'local PNG rendering'}); this is page content, not a source-file link.`,
      })
      output.push({
        type: 'image',
        data: Buffer.from(image.png).toString('base64'),
        mimeType,
      })
    } else if (page.needsImage) {
      if (!skippedImages.includes(page.page)) skippedImages.push(page.page)
    }
    if (page.warning)
      output.push({
        type: 'text',
        text: `[PDF ${fileName} — page ${page.page} extraction warning: ${page.warning}]`,
      })
  }
  if (skippedImages.length > 0) {
    output.push({
      type: 'text',
      text: `[PDF ${fileName}: no PNG sent for page(s) ${unique(skippedImages).join(', ')} because of the image/count/byte limit or a local rendering failure. Available extracted text, if any, was sent.]`,
    })
  }
  if (renderFailure !== undefined)
    output.push({
      type: 'text',
      text: `[PDF ${fileName} PNG rendering failed: ${renderFailure}. No raw PDF or local link was forwarded.]`,
    })
  if (extracted.omittedPages > 0) {
    const first = extracted.pages.length + 1
    output.push({
      type: 'text',
      text: `[PDF ${fileName}: pages ${first}–${extracted.totalPages} were not sent because the configured page limit is ${limits.maxPages}.]`,
    })
  }
  return output
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}
