import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { deflateSync, inflateSync } from 'node:zlib'
import { pdfPrompt } from './pdf.js'
import { extractEmbeddedPageImages, extractPdfText, PdfTextError } from './pdf-text.js'
import {
  projectPrompt,
  readBounded,
  type AttachmentService,
  type OfficeRenderer,
  type PromptLimits,
} from './prompt.js'

function samplePdf(): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>
endobj
4 0 obj
<< /Type /Page /Parent 2 0 R /Resources << >> /Contents 7 0 R >>
endobj
5 0 obj
<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>
endobj
6 0 obj
<< /Length 29 >>
stream
BT /F1 12 Tf (Hello PDF) Tj ET
endstream
endobj
7 0 obj
<< /Length 0 >>
stream

endstream
endobj
%%EOF`)
}

const limits: PromptLimits = {
  maxPages: 10,
  maxPdfBytes: 1024 * 1024,
  maxPageTextChars: 1000,
  maxImages: 2,
  maxTotalImageBytes: 1024 * 1024,
  maxImageDimension: 1024,
  maxImagePixels: 1024 * 1024,
  maxPromptTextChars: 20_000,
}

describe('local PDF text extraction', () => {
  it('extracts page-labelled text and identifies a scanned/empty page for PNG rendering', async () => {
    const result = await extractPdfText(samplePdf())
    expect(result.totalPages).toBe(2)
    expect(result.pages[0]).toMatchObject({ page: 1, complete: true, needsImage: false })
    expect(result.pages[0]?.text).toContain('Hello PDF')
    expect(result.pages[1]).toMatchObject({ page: 2, needsImage: true })
  })

  it('enforces the page limit and records the unsent range', async () => {
    const result = await extractPdfText(samplePdf(), { maxPages: 1 })
    expect(result.pages).toHaveLength(1)
    expect(result.omittedPages).toBe(1)
    const converted = await pdfPrompt('sample.pdf', result, async () => [], limits)
    expect(converted.filter((part) => part.type === 'text').at(-1)?.text).toContain(
      'pages 2–2 were not sent',
    )
  })

  it('rejects encrypted, malformed, and unreadable inputs explicitly', async () => {
    await expect(
      extractPdfText(new TextEncoder().encode('%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >>')),
    ).rejects.toMatchObject({ code: 'encrypted' })
    await expect(extractPdfText(new TextEncoder().encode('not a pdf'))).rejects.toBeInstanceOf(
      PdfTextError,
    )
  })
})

describe('PDF prompt conversion', () => {
  it('sends embedded page text and PNG, never a raw PDF or local link', async () => {
    const converted = await pdfPrompt(
      'mixed.pdf',
      {
        totalPages: 2,
        omittedPages: 0,
        pages: [
          { page: 1, text: 'Selectable text', complete: true, needsImage: false },
          { page: 2, text: '', complete: false, needsImage: true },
        ],
      },
      async (pages) => {
        expect(pages).toEqual([2])
        return [{ page: 2, png: new Uint8Array([137, 80, 78, 71]), width: 20, height: 30 }]
      },
      limits,
    )
    expect(
      converted.some((part) => part.type === 'text' && part.text.includes('mixed.pdf — page 1/2')),
    ).toBe(true)
    expect(converted.some((part) => part.type === 'image' && part.mimeType === 'image/png')).toBe(
      true,
    )
    expect(
      converted.every(
        (part) =>
          part.type !== 'image' || part.data !== Buffer.from(samplePdf()).toString('base64'),
      ),
    ).toBe(true)
    expect(converted.every((part) => part.type !== 'text' || !part.text.includes('file://'))).toBe(
      true,
    )
  })

  it('keeps available text and names pages when PNG rendering fails', async () => {
    const converted = await pdfPrompt(
      'scan.pdf',
      {
        totalPages: 1,
        omittedPages: 0,
        pages: [{ page: 1, text: 'Partial OCR-like text', complete: false, needsImage: true }],
      },
      async () => {
        throw new Error('mock renderer unavailable')
      },
      limits,
    )
    const text = converted.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    expect(text).toContain('Partial OCR-like text')
    expect(text).toContain('no PNG sent for page(s) 1')
    expect(text).toContain('mock renderer unavailable')
  })

  it('enforces image count and byte limits with explicit omissions', async () => {
    const converted = await pdfPrompt(
      'images.pdf',
      {
        totalPages: 2,
        omittedPages: 0,
        pages: [1, 2].map((page) => ({ page, text: '', complete: false, needsImage: true })),
      },
      async () => [
        { page: 1, png: new Uint8Array(20), width: 10, height: 10 },
        { page: 2, png: new Uint8Array(20), width: 10, height: 10 },
      ],
      { ...limits, maxImages: 1, maxTotalImageBytes: 10 },
    )
    expect(converted.filter((part) => part.type === 'image')).toHaveLength(0)
    expect(
      converted.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n'),
    ).toContain('no PNG sent for page(s) 1, 2')
  })
})

describe('current-turn prompt projection', () => {
  it('reads only supplied explicit PDF references and emits text/PNG content blocks', async () => {
    const pdf = samplePdf()
    let fileReads = 0
    const attachments: AttachmentService = {
      async *readFileStream(): AsyncIterable<Uint8Array> {
        fileReads++
        yield pdf
      },
      async readImage(): Promise<{ data: Uint8Array }> {
        return { data: new Uint8Array([1, 2, 3]) }
      },
    }
    const office: OfficeRenderer = {
      async renderImages(
        request,
      ): Promise<{ images: { png: Uint8Array; width: number; height: number; page: number }[] }> {
        expect(request.source.bytes).toEqual(pdf)
        return {
          images: (request.pages ?? []).map((page) => ({
            page,
            png: new Uint8Array([137, 80, 78, 71]),
            width: 10,
            height: 10,
          })),
        }
      },
    }
    const message: UserMessage = createUserMessage({
      content: [
        { type: 'text', text: 'Inspect this attachment' },
        {
          type: 'file',
          attachment: { attachmentId: 'pdf-1', name: 'sample.pdf', bytes: pdf.byteLength },
        },
      ],
      source: { kind: 'user' },
    })
    const content = await projectPrompt([message], attachments, office, limits)
    expect(fileReads).toBe(1)
    expect(content.some((part) => part.type === 'text' && part.text.includes('Hello PDF'))).toBe(
      true,
    )
    expect(content.some((part) => part.type === 'image' && part.mimeType === 'image/png')).toBe(
      true,
    )
    expect(content.every((part) => part.type === 'text' || part.type === 'image')).toBe(true)
  })

  it('does not read non-PDF files or forward path substitutes', async () => {
    let reads = 0
    const attachments: AttachmentService = {
      async *readFileStream(): AsyncIterable<Uint8Array> {
        reads++
        yield new Uint8Array()
      },
      async readImage(): Promise<{ data: Uint8Array }> {
        throw new Error('unused')
      },
    }
    const office: OfficeRenderer = {
      async renderImages(): Promise<{ images: [] }> {
        return { images: [] }
      },
    }
    const message = createUserMessage({
      content: [{ type: 'file', attachment: { attachmentId: 'note', name: 'note.txt', bytes: 3 } }],
      source: { kind: 'user' },
    })
    const content = await projectPrompt([message], attachments, office, limits)
    expect(reads).toBe(0)
    expect(content[0]).toMatchObject({ type: 'text' })
    expect(
      content[0]?.type === 'text' && content[0].text.includes('only explicitly attached PDF'),
    ).toBe(true)
  })

  it('enforces PDF bytes, stream integrity, and submission text limits', async () => {
    await expect(
      readBounded(
        (async function* (): AsyncIterable<Uint8Array> {
          yield new Uint8Array(11)
        })(),
        11,
        10,
      ),
    ).rejects.toThrow('above the 10-byte PDF limit')
    await expect(
      readBounded(
        (async function* (): AsyncIterable<Uint8Array> {
          yield new Uint8Array(2)
        })(),
        3,
        10,
      ),
    ).rejects.toThrow('byte count mismatch')
    const attachments: AttachmentService = {
      async *readFileStream(): AsyncIterable<Uint8Array> {
        throw new Error('unused')
      },
      async readImage(): Promise<{ data: Uint8Array }> {
        throw new Error('unused')
      },
    }
    const office: OfficeRenderer = {
      async renderImages(): Promise<{ images: [] }> {
        return { images: [] }
      },
    }
    const message = createUserMessage({
      content: [
        { type: 'text', text: '1234567890' },
        { type: 'text', text: 'later text' },
      ],
      source: { kind: 'user' },
    })
    const content = await projectPrompt([message], attachments, office, {
      ...limits,
      maxPromptTextChars: 5,
    })
    expect(content[0]).toEqual({ type: 'text', text: '12345' })
    const notice = content.at(-1)
    expect(notice?.type === 'text' && notice.text.includes('later text was not sent')).toBe(true)
  })
})

/** One full-page image XObject; options add content or page features that require rendering. */
function imagePdf(
  imageDict: string,
  imageData: Uint8Array,
  options: { content?: string; pageExtras?: string; inheritedMediaBox?: boolean } = {},
): Uint8Array {
  const encoder = new TextEncoder()
  const content = options.content ?? 'q 2 0 0 1 0 0 cm /Im0 Do Q'
  const mediaBox = '/MediaBox [0 0 2 1]'
  const head = encoder.encode(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 ${options.inheritedMediaBox ? mediaBox : ''} >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R ${options.inheritedMediaBox ? '' : mediaBox} ${options.pageExtras ?? ''} /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${content.length} >>
stream
${content}
endstream
endobj
5 0 obj
<< /Type /XObject /Subtype /Image ${imageDict} /Length ${imageData.length} >>
stream
`)
  const tail = encoder.encode(`
endstream
endobj
%%EOF`)
  const output = new Uint8Array(head.length + imageData.length + tail.length)
  output.set(head, 0)
  output.set(imageData, head.length)
  output.set(tail, head.length + imageData.length)
  return output
}

// Valid 2×1 RGB JPEG (red, green), generated once with Pillow; no decoder dependency in tests.
const SCAN_JPEG = Uint8Array.from(
  Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wAARCAABAAIDAREAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDs/gx/yR7wn/2LVh/6TpX+Yeef8jvFf9fJ/wDpTP8AMj6UX/KTPG//AGN8y/8AU2sf/9k=',
    'base64',
  ),
)
const SCAN_DICT = '/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode'

describe('embedded scan extraction', () => {
  it('returns the page JPEG exactly, without any external renderer', () => {
    const images = extractEmbeddedPageImages(imagePdf(SCAN_DICT, SCAN_JPEG), [1], {
      maxDimension: 2048,
    })
    const image = images.get(1)
    expect(image).toBeDefined()
    expect(image?.mimeType).toBe('image/jpeg')
    expect(image?.width).toBe(2)
    expect(image?.height).toBe(1)
    expect(Array.from(image?.data ?? [])).toEqual(Array.from(SCAN_JPEG))
  })

  it('re-encodes a flate-decoded RGB raster as a valid PNG', () => {
    const pixels = Uint8Array.from([255, 0, 0, 0, 255, 0])
    const document = imagePdf(
      '/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
      new Uint8Array(deflateSync(pixels)),
    )
    const image = extractEmbeddedPageImages(document, [1]).get(1)
    expect(image?.mimeType).toBe('image/png')
    const png = image?.data ?? new Uint8Array()
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    const width =
      ((png[16] ?? 0) << 24) | ((png[17] ?? 0) << 16) | ((png[18] ?? 0) << 8) | (png[19] ?? 0)
    const height =
      ((png[20] ?? 0) << 24) | ((png[21] ?? 0) << 16) | ((png[22] ?? 0) << 8) | (png[23] ?? 0)
    expect(width).toBe(2)
    expect(height).toBe(1)
    const idatBytes =
      (png[33] ?? 0) * 0x1000000 +
      (png[34] ?? 0) * 0x10000 +
      (png[35] ?? 0) * 0x100 +
      (png[36] ?? 0)
    expect(Buffer.from(png.subarray(37, 41)).toString('ascii')).toBe('IDAT')
    const decoded = new Uint8Array(inflateSync(png.subarray(41, 41 + idatBytes)))
    expect(Array.from(decoded)).toEqual([0, 255, 0, 0, 0, 255, 0])
  })

  it('supports a scan with an inherited page box', () => {
    const image = extractEmbeddedPageImages(
      imagePdf(SCAN_DICT, SCAN_JPEG, { inheritedMediaBox: true }),
      [1],
    ).get(1)
    expect(image?.mimeType).toBe('image/jpeg')
  })

  it('declines masks, decode changes, overlays, clipping, crop/rotation, and unsafe dimensions', () => {
    expect(
      extractEmbeddedPageImages(imagePdf(SCAN_DICT, SCAN_JPEG), [1], { maxDimension: 1 }).size,
    ).toBe(0)
    expect(
      extractEmbeddedPageImages(imagePdf(SCAN_DICT, SCAN_JPEG), [1], { maxPixels: 1 }).size,
    ).toBe(0)
    for (const extra of [
      '/DecodeParms << /Predictor 10 >>',
      '/ImageMask true',
      '/SMask 6 0 R',
      '/Mask 6 0 R',
      '/Decode [1 0 1 0 1 0]',
      '/Interpolate true',
    ]) {
      expect(
        extractEmbeddedPageImages(imagePdf(`${SCAN_DICT} ${extra}`, SCAN_JPEG), [1]).size,
      ).toBe(0)
    }
    for (const content of [
      'q 2 0 0 1 0 0 cm /Im0 Do Q 0 0 m 1 1 l S',
      'q 0 0 1 1 re W n 2 0 0 1 0 0 cm /Im0 Do Q',
      'q 2 0 0 1 0 0 cm q 1 0 0 1 0 0 cm /Im0 Do Q Q',
      'q 2 0 0 1 0 0 cm /Im0 Do /Im0 Do Q',
    ]) {
      expect(extractEmbeddedPageImages(imagePdf(SCAN_DICT, SCAN_JPEG, { content }), [1]).size).toBe(
        0,
      )
    }
    for (const pageExtras of [
      '/CropBox [0 0 1 1]',
      '/Rotate 90',
      '/Annots [<< /Type /Annot /Subtype /Text >>]',
      '/Group << /Type /Group >>',
    ]) {
      expect(
        extractEmbeddedPageImages(imagePdf(SCAN_DICT, SCAN_JPEG, { pageExtras }), [1]).size,
      ).toBe(0)
    }
    expect(
      extractEmbeddedPageImages(
        imagePdf(
          '/Width 4 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
          SCAN_JPEG,
        ),
        [1],
      ).size,
    ).toBe(0)
    expect(extractEmbeddedPageImages(samplePdf(), [1, 2]).size).toBe(0)
  })

  it('rejects non-8-bit or calibrated raw rasters before decoding them', () => {
    const pixels = deflateSync(Uint8Array.from([255, 0, 0, 0, 255, 0]))
    for (const imageDict of [
      '/Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 4 /Filter /FlateDecode',
      '/Width 2 /Height 1 /ColorSpace [/ICCBased 6 0 R] /BitsPerComponent 8 /Filter /FlateDecode',
    ]) {
      expect(extractEmbeddedPageImages(imagePdf(imageDict, pixels), [1]).size).toBe(0)
    }
  })

  it('uses bounded whole-page rendering when direct scan extraction is not equivalent', async () => {
    const document = imagePdf(`${SCAN_DICT} /SMask 6 0 R`, SCAN_JPEG)
    const extracted = await extractPdfText(document)
    const embedded = extractEmbeddedPageImages(document, [1])
    expect(embedded.size).toBe(0)
    let rendered = 0
    const converted = await pdfPrompt(
      'masked-scan.pdf',
      extracted,
      async (pages) => {
        rendered++
        expect(pages).toEqual([1])
        return [{ page: 1, png: new Uint8Array([137, 80, 78, 71]), width: 2, height: 1 }]
      },
      limits,
      embedded,
    )
    expect(rendered).toBe(1)
    expect(converted.some((part) => part.type === 'image' && part.mimeType === 'image/png')).toBe(
      true,
    )
    expect(converted.some((part) => part.type === 'image' && part.mimeType === 'image/jpeg')).toBe(
      false,
    )
  })

  it('lets the prompt use the embedded scan image and skip the renderer', async () => {
    const document = imagePdf(SCAN_DICT, SCAN_JPEG)
    const extracted = await extractPdfText(document)
    const embedded = extractEmbeddedPageImages(document, [1])
    let rendered = 0
    const converted = await pdfPrompt(
      'scan.pdf',
      extracted,
      async () => {
        rendered += 1
        return []
      },
      limits,
      embedded,
    )
    expect(rendered).toBe(0)
    expect(converted.some((part) => part.type === 'image' && part.mimeType === 'image/jpeg')).toBe(
      true,
    )
    const text = converted.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
    expect(text).toContain('embedded scan JPEG')
    expect(text).not.toContain('no PNG sent')
  })
})
