import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { AcpPromptContent } from './acp-client.js'

export interface FileAttachmentRef {
  attachmentId: string
  name: string
  bytes: number
}

export interface ImageAttachmentRef {
  attachmentId: string
  name?: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}
import { extractEmbeddedPageImages, extractPdfText } from './pdf-text.js'
import { pdfPrompt, type PdfConversionLimits } from './pdf.js'

export interface AttachmentService {
  readFileStream(ref: FileAttachmentRef, signal?: AbortSignal): AsyncIterable<Uint8Array>
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{ data: Uint8Array }>
}

export interface OfficeRenderer {
  renderImages(
    request: {
      extension: 'pdf'
      source: { key: string; version: string; bytes: Uint8Array }
      pages?: readonly number[]
      dpi?: number
      maxImages: number
      maxPixels: number
      maxDimension: number
      maxBytes: number
    },
    signal?: AbortSignal,
  ): Promise<{
    images: readonly { png: Uint8Array; width: number; height: number; page?: number }[]
  }>
}

export interface PromptLimits extends PdfConversionLimits {
  maxPdfBytes: number
  maxImageDimension: number
  maxImagePixels: number
  maxPromptTextChars: number
}

/** Hard ceiling on one local PDF render; a stalled engine must never wedge a chat turn. */
const PDF_RENDER_TIMEOUT_MS = 20_000

function renderSignal(signal: AbortSignal | undefined): AbortSignal {
  const deadline = AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS)
  return signal === undefined ? deadline : AbortSignal.any([signal, deadline])
}

function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

export async function readBounded(
  stream: AsyncIterable<Uint8Array>,
  declaredBytes: number,
  maxBytes: number,
): Promise<Uint8Array> {
  if (declaredBytes > maxBytes)
    throw new Error(`file is ${declaredBytes} bytes, above the ${maxBytes}-byte PDF limit`)
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    total += chunk.byteLength
    if (total > maxBytes) throw new Error(`file exceeds the ${maxBytes}-byte PDF limit`)
    chunks.push(chunk)
  }
  if (total !== declaredBytes)
    throw new Error(`file byte count mismatch (declared ${declaredBytes}, read ${total})`)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Project only the supplied current-turn messages; never inspect durable history. */
export async function projectPrompt(
  messages: readonly UserMessage[],
  attachments: AttachmentService,
  office: OfficeRenderer,
  limits: PromptLimits,
  signal?: AbortSignal,
): Promise<AcpPromptContent[]> {
  const content: AcpPromptContent[] = []
  let textChars = 0
  let textOmitted = false
  let remainingImageBytes = limits.maxTotalImageBytes
  const text = (value: string): void => {
    const remaining = limits.maxPromptTextChars - textChars
    if (remaining <= 0) {
      textOmitted = true
      return
    }
    if (value.length > remaining) {
      content.push({ type: 'text', text: value.slice(0, remaining) })
      textChars = limits.maxPromptTextChars
      textOmitted = true
    } else {
      content.push({ type: 'text', text: value })
      textChars += value.length
    }
  }
  for (const message of messages) {
    for (const block of message.content) {
      signal?.throwIfAborted()
      if (block.type === 'text') text(block.text)
      else if (block.type === 'image') {
        const stored = await attachments.readImage(block.attachment, signal)
        if (stored.data.byteLength > remainingImageBytes) {
          text(
            `[Image ${block.attachment.name ?? block.attachment.attachmentId} was not sent: the submission image-byte limit was reached.]`,
          )
        } else {
          content.push({
            type: 'image',
            data: Buffer.from(stored.data).toString('base64'),
            mimeType: block.attachment.mediaType,
          })
          remainingImageBytes -= stored.data.byteLength
        }
      } else if (block.type === 'file') {
        const ref = block.attachment
        if (!/\.pdf$/iu.test(ref.name)) {
          text(
            `[File ${ref.name} was not sent: this route converts only explicitly attached PDF files; no local path or raw file was forwarded.]`,
          )
          continue
        }
        try {
          const bytes = await readBounded(
            attachments.readFileStream(ref, signal),
            ref.bytes,
            limits.maxPdfBytes,
          )
          const extracted = await extractPdfText(bytes, limits)
          const imagePages = extracted.pages
            .filter((page) => page.needsImage)
            .map((page) => page.page)
          const embedded = extractEmbeddedPageImages(bytes, imagePages, {
            maxDimension: limits.maxImageDimension,
            maxPixels: limits.maxImagePixels,
            maxBytes: Math.max(0, remainingImageBytes),
          })
          const converted = await pdfPrompt(
            ref.name,
            extracted,
            async (pages, maxImages, maxBytes) => {
              const rendered = await withDeadline(
                office.renderImages(
                  {
                    extension: 'pdf',
                    source: { key: ref.attachmentId, version: String(ref.bytes), bytes },
                    pages,
                    dpi: 144,
                    maxImages,
                    maxPixels: limits.maxImagePixels,
                    maxDimension: limits.maxImageDimension,
                    maxBytes,
                  },
                  renderSignal(signal),
                ),
                PDF_RENDER_TIMEOUT_MS,
                `the local renderer did not finish within ${PDF_RENDER_TIMEOUT_MS}ms`,
              )
              return rendered.images
            },
            { ...limits, maxTotalImageBytes: remainingImageBytes },
            embedded,
          )
          for (const part of converted) {
            if (part.type === 'image') {
              remainingImageBytes -= Math.floor((part.data.length * 3) / 4)
              content.push(part)
            } else text(part.text)
          }
        } catch (error) {
          signal?.throwIfAborted()
          text(
            `[PDF ${ref.name} was not sent${ref.bytes > limits.maxPdfBytes ? '' : ' in whole or in part where conversion failed'}: ${error instanceof Error ? error.message : String(error)}. No raw PDF bytes or local file link were forwarded.]`,
          )
        }
      } else {
        text(
          `[A ${block.type} block was not sent: only explicit text, images, and PDF file references are accepted on this route.]`,
        )
      }
    }
  }
  if (textOmitted)
    content.push({
      type: 'text',
      text: `[Submission text limit ${limits.maxPromptTextChars} reached; later text was not sent.]`,
    })
  return content
}
