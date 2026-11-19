import { deflateSync, inflateSync } from 'node:zlib'

export interface PdfTextLimits {
  maxPages?: number
  maxPageTextChars?: number
}

export interface PdfPageText {
  page: number
  text: string
  complete: boolean
  needsImage: boolean
  warning?: string
}

export interface PdfTextResult {
  pages: readonly PdfPageText[]
  totalPages: number
  omittedPages: number
}

export class PdfTextError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'encrypted' | 'unsupported' | 'limit',
  ) {
    super(message)
    this.name = 'PdfTextError'
  }
}

interface Ref {
  kind: 'ref'
  object: number
  generation: number
}
interface Name {
  kind: 'name'
  value: string
}
interface PdfString {
  kind: 'string'
  bytes: Uint8Array
}
interface Dict {
  kind: 'dict'
  entries: Map<string, unknown>
}
interface Stream {
  kind: 'stream'
  dict: Dict
  data: Uint8Array
}
type Value = Ref | Name | PdfString | Dict | Stream | unknown[] | number | boolean | null

const MAX_OBJECTS = 30_000
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_DEPTH = 40
const latin1 = new TextDecoder('latin1')
const utf16be = (bytes: Uint8Array): string => {
  const copy = new Uint8Array(bytes.length - (bytes.length % 2))
  copy.set(bytes.subarray(0, copy.length))
  for (let index = 0; index < copy.length; index += 2) {
    const first = copy[index] ?? 0
    copy[index] = copy[index + 1] ?? 0
    copy[index + 1] = first
  }
  return new TextDecoder('utf-16le').decode(copy)
}

function isRef(value: unknown): value is Ref {
  return typeof value === 'object' && value !== null && (value as Ref).kind === 'ref'
}
function isName(value: unknown): value is Name {
  return typeof value === 'object' && value !== null && (value as Name).kind === 'name'
}
function isString(value: unknown): value is PdfString {
  return typeof value === 'object' && value !== null && (value as PdfString).kind === 'string'
}
function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && (value as Dict).kind === 'dict'
}
function isStream(value: unknown): value is Stream {
  return typeof value === 'object' && value !== null && (value as Stream).kind === 'stream'
}
function nameOf(value: unknown): string | undefined {
  return isName(value) ? value.value : undefined
}
function dictOf(value: unknown): Dict | undefined {
  return isStream(value) ? value.dict : isDict(value) ? value : undefined
}

class Parser {
  position = 0
  constructor(readonly bytes: Uint8Array) {}

  skipSpace(): void {
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position] ?? 0
      if (byte === 37) {
        while (
          this.position < this.bytes.length &&
          ![10, 13].includes(this.bytes[this.position] ?? 0)
        )
          this.position++
      } else if ([0, 9, 10, 12, 13, 32].includes(byte)) this.position++
      else break
    }
  }

  parse(depth = 0): unknown {
    if (depth > MAX_DEPTH) throw new PdfTextError('PDF object nesting is too deep.', 'limit')
    this.skipSpace()
    const byte = this.bytes[this.position]
    if (byte === 47) return this.parseName()
    if (byte === 40) return this.parseLiteral()
    if (byte === 60 && this.bytes[this.position + 1] === 60) return this.parseDict(depth + 1)
    if (byte === 60) return this.parseHex()
    if (byte === 91) return this.parseArray(depth + 1)
    if (byte === 93 || byte === 62) return undefined
    const token = this.token()
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token)) {
      const save = this.position
      this.skipSpace()
      const second = this.token()
      this.skipSpace()
      const third = this.token()
      if (/^\d+$/u.test(token) && /^\d+$/u.test(second) && third === 'R') {
        return { kind: 'ref', object: Number(token), generation: Number(second) } satisfies Ref
      }
      this.position = save
      return Number(token)
    }
    return { kind: 'keyword', value: token }
  }

  private parseName(): Name {
    this.position++
    const raw = this.token()
    const value = raw.replace(/#([0-9a-fA-F]{2})/gu, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    return { kind: 'name', value }
  }

  private parseLiteral(): PdfString {
    this.position++
    const output: number[] = []
    let depth = 1
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position++] ?? 0
      if (byte === 92) {
        const escaped = this.bytes[this.position++]
        if (escaped === undefined) break
        const simple: Record<number, number> = {
          110: 10,
          114: 13,
          116: 9,
          98: 8,
          102: 12,
          40: 40,
          41: 41,
          92: 92,
        }
        const mapped = simple[escaped]
        if (mapped !== undefined) output.push(mapped)
        else if (escaped >= 48 && escaped <= 55) {
          let value = escaped - 48
          for (let count = 0; count < 2; count++) {
            const next = this.bytes[this.position]
            if (next === undefined || next < 48 || next > 55) break
            value = value * 8 + (this.position++, next - 48)
          }
          output.push(value & 255)
        } else if (escaped === 13) {
          if (this.bytes[this.position] === 10) this.position++
        } else if (escaped !== 10) output.push(escaped)
      } else if (byte === 40) {
        depth++
        output.push(byte)
      } else if (byte === 41) {
        depth--
        if (depth === 0) break
        output.push(byte)
      } else output.push(byte)
      if (output.length > MAX_STREAM_BYTES)
        throw new PdfTextError('PDF string exceeds the parsing limit.', 'limit')
    }
    return { kind: 'string', bytes: Uint8Array.from(output) }
  }

  private parseHex(): PdfString {
    this.position++
    let hex = ''
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position++] ?? 0
      if (byte === 62) break
      const char = String.fromCharCode(byte)
      if (/[0-9a-fA-F]/u.test(char)) hex += char
    }
    if (hex.length % 2 === 1) hex += '0'
    const output = new Uint8Array(hex.length / 2)
    for (let index = 0; index < output.length; index++)
      output[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
    return { kind: 'string', bytes: output }
  }

  private parseArray(depth: number): unknown[] {
    this.position++
    const result: unknown[] = []
    while (this.position < this.bytes.length) {
      this.skipSpace()
      if (this.bytes[this.position] === 93) {
        this.position++
        break
      }
      const value = this.parse(depth)
      if (value === undefined) break
      result.push(value)
      if (result.length > MAX_OBJECTS)
        throw new PdfTextError('PDF array exceeds the parsing limit.', 'limit')
    }
    return result
  }

  private parseDict(depth: number): Dict {
    this.position += 2
    const entries = new Map<string, unknown>()
    while (this.position < this.bytes.length) {
      this.skipSpace()
      if (this.bytes[this.position] === 62 && this.bytes[this.position + 1] === 62) {
        this.position += 2
        break
      }
      const key = this.parse(depth)
      if (!isName(key)) break
      entries.set(key.value, this.parse(depth))
      if (entries.size > MAX_OBJECTS)
        throw new PdfTextError('PDF dictionary exceeds the parsing limit.', 'limit')
    }
    return { kind: 'dict', entries }
  }

  private token(): string {
    const start = this.position
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position] ?? 0
      if ([0, 9, 10, 12, 13, 32, 40, 41, 60, 62, 91, 93, 123, 125, 47, 37].includes(byte)) break
      this.position++
    }
    return latin1.decode(this.bytes.subarray(start, this.position))
  }
}

class Document {
  readonly objects = new Map<number, unknown>()
  private readonly decoded = new Map<number, Uint8Array | Error>()

  constructor(readonly bytes: Uint8Array) {
    if (latin1.decode(bytes.subarray(0, 5)) !== '%PDF-')
      throw new PdfTextError('The file has no valid %PDF header.', 'invalid')
    const source = latin1.decode(bytes)
    if (/\/Encrypt\s+\d+\s+\d+\s+R\b/u.test(source))
      throw new PdfTextError('The PDF is encrypted; no pages were read.', 'encrypted')
    this.scanObjects()
    this.expandObjectStreams()
  }

  resolve(value: unknown, depth = 0): unknown {
    if (!isRef(value)) return value
    if (depth > MAX_DEPTH)
      throw new PdfTextError('PDF indirect-reference cycle detected.', 'invalid')
    return this.resolve(this.objects.get(value.object), depth + 1)
  }

  entry(dict: Dict, key: string): unknown {
    return this.resolve(dict.entries.get(key))
  }

  stream(value: unknown): Uint8Array {
    const resolved = this.resolve(value)
    if (!isStream(resolved)) throw new PdfTextError('PDF page content is not a stream.', 'invalid')
    const cached = this.decoded.get(resolved.dict.entries.get('__object') as number)
    if (cached instanceof Uint8Array) return cached
    if (cached instanceof Error) throw cached
    try {
      let data = resolved.data
      const filters = this.resolve(resolved.dict.entries.get('Filter'))
      const list = Array.isArray(filters) ? filters : filters === undefined ? [] : [filters]
      for (const filter of list) {
        const name = nameOf(this.resolve(filter))
        if (name === 'FlateDecode' || name === 'Fl') {
          data = inflateSync(data, { maxOutputLength: MAX_STREAM_BYTES, finishFlush: 2 })
        } else if (name === 'ASCIIHexDecode' || name === 'AHx') data = asciiHex(data)
        else
          throw new PdfTextError(
            `Unsupported PDF stream filter ${name ?? 'unknown'}; render this page instead.`,
            'unsupported',
          )
      }
      return data
    } catch (error) {
      if (error instanceof PdfTextError) throw error
      throw new PdfTextError(
        `Unable to decompress PDF content: ${error instanceof Error ? error.message : String(error)}`,
        'invalid',
      )
    }
  }

  pages(): Dict[] {
    const catalogs: Dict[] = []
    for (const value of this.objects.values()) {
      const dict = dictOf(value)
      if (dict !== undefined && nameOf(this.resolve(dict.entries.get('Type'))) === 'Catalog')
        catalogs.push(dict)
    }
    const pages: Dict[] = []
    const visited = new Set<unknown>()
    const inherited: Record<string, unknown> = {}
    const inheritable = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const
    const walk = (value: unknown, depth: number, inherited: Record<string, unknown> = {}): void => {
      if (depth > MAX_DEPTH || pages.length > MAX_OBJECTS)
        throw new PdfTextError('PDF page tree exceeds the parsing limit.', 'limit')
      const resolved = this.resolve(value)
      if (visited.has(resolved))
        throw new PdfTextError('PDF page tree contains a cycle.', 'invalid')
      visited.add(resolved)
      const dict = dictOf(resolved)
      if (dict === undefined) return
      const type = nameOf(this.resolve(dict.entries.get('Type')))
      if (type === 'Page' || (!dict.entries.has('Kids') && dict.entries.has('Contents'))) {
        for (const key of inheritable) {
          const value = inherited[key]
          if (value !== undefined && !dict.entries.has(key)) dict.entries.set(key, value)
        }
        pages.push(dict)
        return
      }
      const nextInherited = { ...inherited }
      for (const key of inheritable) {
        if (dict.entries.has(key)) nextInherited[key] = dict.entries.get(key)
      }
      const kids = this.resolve(dict.entries.get('Kids'))
      if (!Array.isArray(kids)) return
      for (const kid of kids) walk(kid, depth + 1, nextInherited)
    }
    let started = false
    for (const catalog of catalogs) {
      const root = catalog.entries.get('Pages')
      if (root !== undefined) {
        walk(root, 0, inherited)
        started = true
        break
      }
    }
    if (!started) {
      for (const value of this.objects.values()) {
        const dict = dictOf(value)
        if (dict !== undefined && nameOf(this.resolve(dict.entries.get('Type'))) === 'Page')
          pages.push(dict)
      }
    }
    if (pages.length === 0)
      throw new PdfTextError('No readable pages were found; the PDF may be damaged.', 'invalid')
    return pages
  }

  private scanObjects(): void {
    const source = latin1.decode(this.bytes)
    const pattern = /(^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/gu
    let match: RegExpExecArray | null
    while ((match = pattern.exec(source)) !== null) {
      if (this.objects.size >= MAX_OBJECTS)
        throw new PdfTextError('PDF contains too many indirect objects.', 'limit')
      const object = Number(match[2])
      const start = pattern.lastIndex
      const parser = new Parser(this.bytes)
      parser.position = start
      let value: unknown
      try {
        value = parser.parse()
      } catch {
        continue
      }
      parser.skipSpace()
      if (
        isDict(value) &&
        latin1.decode(this.bytes.subarray(parser.position, parser.position + 6)) === 'stream'
      ) {
        parser.position += 6
        if (this.bytes[parser.position] === 13) parser.position++
        if (this.bytes[parser.position] === 10) parser.position++
        const dataStart = parser.position
        const lengthValue = value.entries.get('Length')
        let length =
          typeof lengthValue === 'number' && Number.isSafeInteger(lengthValue) && lengthValue >= 0
            ? lengthValue
            : -1
        if (
          length < 0 ||
          dataStart + length > this.bytes.length ||
          latin1
            .decode(this.bytes.subarray(dataStart + length, dataStart + length + 20))
            .trimStart()
            .startsWith('endstream') === false
        ) {
          const end = source.indexOf('endstream', dataStart)
          if (end < 0) continue
          length = Math.max(
            0,
            end - dataStart - (source[end - 1] === '\n' ? (source[end - 2] === '\r' ? 2 : 1) : 0),
          )
        }
        value = {
          kind: 'stream',
          dict: value,
          data: this.bytes.subarray(dataStart, dataStart + length),
        } satisfies Stream
        pattern.lastIndex = dataStart + length
      }
      value = tagObject(value, object)
      if (!this.objects.has(object)) this.objects.set(object, value)
    }
  }

  private expandObjectStreams(): void {
    const streams = [...this.objects.entries()].filter(([, value]) => {
      const dict = dictOf(value)
      return (
        isStream(value) &&
        dict !== undefined &&
        nameOf(this.resolve(dict.entries.get('Type'))) === 'ObjStm'
      )
    })
    for (const [objectNumber, value] of streams) {
      try {
        const data = this.stream(value)
        const dict = (value as Stream).dict
        const count = this.resolve(dict.entries.get('N'))
        const first = this.resolve(dict.entries.get('First'))
        if (
          typeof count !== 'number' ||
          typeof first !== 'number' ||
          count < 0 ||
          count > MAX_OBJECTS
        )
          continue
        const parser = new Parser(data)
        const headers: { object: number; offset: number }[] = []
        for (let index = 0; index < count; index++) {
          const number = parser.parse()
          const offset = parser.parse()
          if (typeof number !== 'number' || typeof offset !== 'number') break
          headers.push({ object: number, offset })
        }
        for (const header of headers) {
          if (this.objects.has(header.object)) continue
          parser.position = first + header.offset
          this.objects.set(header.object, tagObject(parser.parse(), header.object))
        }
        this.objects.delete(objectNumber)
      } catch {
        // Other pages may remain readable; an affected page reports an explicit incomplete result.
      }
    }
  }
}

function tagObject(value: unknown, object: number): unknown {
  const dict = dictOf(value)
  dict?.entries.set('__object', object)
  return value
}

function asciiHex(data: Uint8Array): Uint8Array {
  const text = latin1.decode(data).replace(/\s+/gu, '').replace(/>.*$/su, '')
  const padded = text.length % 2 ? `${text}0` : text
  if (!/^[0-9a-fA-F]*$/u.test(padded)) throw new PdfTextError('Invalid ASCIIHex stream.', 'invalid')
  const output = new Uint8Array(padded.length / 2)
  for (let index = 0; index < output.length; index++)
    output[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16)
  return output
}

interface Font {
  codes: Map<number, string>
  width: number
}

function unicodeDestination(value: string): string {
  const bytes = hexBytes(value)
  return utf16be(bytes)
}

function hexBytes(value: string): Uint8Array {
  const padded = value.length % 2 ? `${value}0` : value
  const bytes = new Uint8Array(padded.length / 2)
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

function readFont(document: Document, value: unknown): Font {
  const dict = document.resolve(value)
  if (!isDict(dict)) return { codes: new Map(), width: 1 }
  const cmapValue = dict.entries.get('ToUnicode')
  if (cmapValue === undefined) return { codes: new Map(), width: 1 }
  const data = latin1.decode(document.stream(cmapValue))
  const codes = new Map<number, string>()
  for (const block of data.matchAll(/beginbfchar(.*?)endbfchar/gsu)) {
    for (const match of block[1]?.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/gu) ?? []) {
      if (match[1] && match[2])
        codes.set(Number.parseInt(match[1], 16), unicodeDestination(match[2]))
    }
  }
  for (const block of data.matchAll(/beginbfrange(.*?)endbfrange/gsu)) {
    for (const match of block[1]?.matchAll(
      /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[^>]+>|\[[^\]]*\])/gu,
    ) ?? []) {
      if (!match[1] || !match[2] || !match[3]) continue
      const start = Number.parseInt(match[1], 16)
      const end = Math.min(Number.parseInt(match[2], 16), start + 65_535)
      if (match[3].startsWith('[')) {
        const destinations = [...match[3].matchAll(/<([0-9a-fA-F]+)>/gu)]
        for (let code = start; code <= end; code++) {
          const destination = destinations[code - start]?.[1]
          if (destination) codes.set(code, unicodeDestination(destination))
        }
      } else {
        const destination = match[3].slice(1, -1)
        const base = Number.parseInt(destination, 16)
        for (let code = start; code <= end; code++)
          codes.set(code, String.fromCodePoint(base + code - start))
      }
    }
  }
  const width = [...codes.keys()].some((code) => code > 255) ? 2 : 1
  return { codes, width }
}

function decodeText(value: PdfString, font: Font): string {
  if (font.codes.size > 0) {
    let text = ''
    for (let index = 0; index < value.bytes.length; index += font.width) {
      let code = 0
      for (let offset = 0; offset < font.width; offset++)
        code = code * 256 + (value.bytes[index + offset] ?? 0)
      text += font.codes.get(code) ?? '\ufffd'
    }
    return text
  }
  if (value.bytes.length >= 2 && value.bytes[0] === 254 && value.bytes[1] === 255)
    return utf16be(value.bytes.subarray(2))
  if (value.bytes.length >= 4 && value.bytes.length % 2 === 0 && value.bytes[0] === 0)
    return utf16be(value.bytes)
  return new TextDecoder('windows-1252').decode(value.bytes)
}

interface ContentToken {
  value: unknown
  keyword?: string
}

function contentTokens(data: Uint8Array): ContentToken[] {
  const parser = new Parser(data)
  const tokens: ContentToken[] = []
  while (true) {
    parser.skipSpace()
    if (parser.position >= data.length) break
    const before = parser.position
    const value = parser.parse()
    if (parser.position === before) {
      parser.position++
      continue
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      (value as { kind?: string }).kind === 'keyword'
    )
      tokens.push({ keyword: (value as unknown as { value: string }).value, value })
    else tokens.push({ value })
    if (tokens.length > 1_000_000)
      throw new PdfTextError('PDF content stream has too many tokens.', 'limit')
  }
  return tokens
}

const graphics = new Set([
  're',
  'l',
  'c',
  'v',
  'y',
  'h',
  'S',
  's',
  'f',
  'F',
  'f*',
  'B',
  'B*',
  'b',
  'b*',
  'BI',
  'Do',
])

function pageText(document: Document, page: Dict): { text: string; needsImage: boolean } {
  const contents = document.resolve(page.entries.get('Contents'))
  const streams = Array.isArray(contents) ? contents : [contents]
  const data = streams
    .map((stream) => document.stream(stream))
    .filter((stream) => stream.length > 0)
  const tokens = contentTokens(concat(data))
  const resources = document.resolve(page.entries.get('Resources'))
  const fonts = isDict(resources) ? document.resolve(resources.entries.get('Font')) : undefined
  let font: Font = { codes: new Map(), width: 1 }
  let output = ''
  let needsImage = false
  const stack: unknown[] = []
  const append = (text: string): void => {
    if (text) output += text
  }
  const newline = (): void => {
    if (output && !output.endsWith('\n')) output += '\n'
  }
  for (const token of tokens) {
    if (token.keyword === undefined) {
      stack.push(token.value)
      continue
    }
    const operator = token.keyword
    if (graphics.has(operator)) needsImage = true
    if (operator === 'Tf') {
      const fontName = stack.at(-2)
      if (isName(fontName) && isDict(fonts))
        font = readFont(document, fonts.entries.get(fontName.value))
    } else if (operator === 'Tj' || operator === "'" || operator === '"') {
      const value = stack.at(-1)
      if (isString(value)) append(decodeText(value, font))
      newline()
    } else if (operator === 'TJ') {
      const array = stack.at(-1)
      if (Array.isArray(array)) {
        for (const item of array) {
          if (isString(item)) append(decodeText(item, font))
          else if (typeof item === 'number' && item < -180) append(' ')
        }
      }
    } else if (operator === 'Td' || operator === 'TD' || operator === 'T*' || operator === 'Tm')
      newline()
    stack.length = 0
  }
  return {
    text: output
      .replace(/[\t ]+\n/gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim(),
    needsImage,
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length + 1, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
    output[offset++] = 10
  }
  return output
}

/** Bounded local extraction. Unsupported/incomplete pages must also be rendered as PNG by the caller. */
export async function extractPdfText(
  bytes: Uint8Array,
  limits: PdfTextLimits = {},
): Promise<PdfTextResult> {
  const maxPages = Math.max(1, Math.min(limits.maxPages ?? 20, 100))
  const maxChars = Math.max(100, Math.min(limits.maxPageTextChars ?? 16_000, 100_000))
  const document = new Document(bytes)
  const allPages = document.pages()
  const pages: PdfPageText[] = []
  for (let index = 0; index < Math.min(maxPages, allPages.length); index++) {
    const page = allPages[index]
    if (page === undefined) continue
    try {
      const extracted = pageText(document, page)
      let text = extracted.text
      let complete = true
      let warning: string | undefined
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n[Text truncated at ${maxChars} characters; this page is also rendered as PNG.]`
        complete = false
        warning = `page ${index + 1}: text exceeded ${maxChars} characters`
      }
      pages.push({
        page: index + 1,
        text,
        complete,
        needsImage: extracted.needsImage || !complete || text.trim().length === 0,
        ...(warning ? { warning } : {}),
      })
    } catch (error) {
      pages.push({
        page: index + 1,
        text: '',
        complete: false,
        needsImage: true,
        warning: `page ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return {
    pages,
    totalPages: allPages.length,
    omittedPages: Math.max(0, allPages.length - pages.length),
  }
}

export interface PdfEmbeddedImage {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

export interface PdfEmbeddedImageLimits {
  maxDimension?: number
  maxPixels?: number
  maxBytes?: number
}

/**
 * Forward a scan directly only when the complete page is provably just that raster.
 * Every other page falls back to the caller's bounded whole-page renderer.
 */
export function extractEmbeddedPageImages(
  bytes: Uint8Array,
  pageNumbers: readonly number[],
  limits: PdfEmbeddedImageLimits = {},
): Map<number, PdfEmbeddedImage> {
  const images = new Map<number, PdfEmbeddedImage>()
  if (pageNumbers.length === 0) return images
  const document = new Document(bytes)
  const all = document.pages()
  for (const pageNumber of pageNumbers) {
    const page = all[pageNumber - 1]
    if (page === undefined) continue
    try {
      const stream = pageImageStream(document, page)
      if (stream === undefined) continue
      const image = decodeEmbeddedImage(document, stream, limits)
      if (image !== undefined) images.set(pageNumber, image)
    } catch {
      // Unsupported or damaged page images fall back to the caller's renderer.
    }
  }
  return images
}

interface ImagePlacement {
  name: string
  width: number
  height: number
}

function pageImageStream(document: Document, page: Dict): Stream | undefined {
  const placement = plainFullPageImage(document, page)
  if (placement === undefined) return undefined
  const resources = document.resolve(page.entries.get('Resources'))
  if (!isDict(resources)) return undefined
  const xobjects = document.resolve(resources.entries.get('XObject'))
  if (!isDict(xobjects)) return undefined
  const resolved = document.resolve(xobjects.entries.get(placement.name))
  if (!isStream(resolved)) return undefined
  if (nameOf(document.resolve(resolved.dict.entries.get('Subtype'))) !== 'Image') return undefined
  const width = numberEntry(document, resolved.dict, 'Width')
  const height = numberEntry(document, resolved.dict, 'Height')
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined
  // Uniform scaling preserves the complete page's visible geometry; cropping/distortion does not.
  if (!nearlyEqual(placement.width / placement.height, width / height)) return undefined
  return resolved
}

/** Accept exactly: q a 0 0 d e f cm /Image Do Q, filling the unrotated page box. */
function plainFullPageImage(document: Document, page: Dict): ImagePlacement | undefined {
  const media = pageBox(document, page, 'MediaBox')
  if (media === undefined) return undefined
  const [left, bottom, right, top] = media
  const pageWidth = right - left
  const pageHeight = top - bottom
  if (pageWidth <= 0 || pageHeight <= 0) return undefined
  if (page.entries.has('CropBox')) {
    const crop = pageBox(document, page, 'CropBox')
    if (crop === undefined || !crop.every((value, index) => nearlyEqual(value, media[index]!)))
      return undefined
  }
  const rotate = numberEntry(document, page, 'Rotate')
  if ((page.entries.has('Rotate') && rotate === undefined) || (rotate ?? 0) % 360 !== 0)
    return undefined
  const userUnit = numberEntry(document, page, 'UserUnit')
  if ((page.entries.has('UserUnit') && userUnit === undefined) || (userUnit ?? 1) !== 1)
    return undefined
  if (page.entries.has('Group')) return undefined
  if (page.entries.has('Annots')) {
    const annotations = document.resolve(page.entries.get('Annots'))
    if (!Array.isArray(annotations) || annotations.length > 0) return undefined
  }

  const contents = document.resolve(page.entries.get('Contents'))
  const streams = Array.isArray(contents) ? contents : [contents]
  const data = streams
    .map((stream) => document.stream(stream))
    .filter((stream) => stream.length > 0)
  const stack: unknown[] = []
  let stage = 0
  let matrix: number[] | undefined
  let name: string | undefined
  for (const token of contentTokens(concat(data))) {
    if (token.keyword === undefined) {
      stack.push(token.value)
      continue
    }
    if (token.keyword === 'q' && stage === 0 && stack.length === 0) {
      stage = 1
    } else if (
      token.keyword === 'cm' &&
      stage === 1 &&
      stack.length === 6 &&
      stack.every((value) => typeof value === 'number' && Number.isFinite(value))
    ) {
      matrix = [...stack] as number[]
      stage = 2
    } else if (token.keyword === 'Do' && stage === 2 && stack.length === 1 && isName(stack[0])) {
      name = stack[0].value
      stage = 3
    } else if (token.keyword === 'Q' && stage === 3 && stack.length === 0) {
      stage = 4
    } else {
      return undefined
    }
    stack.length = 0
  }
  if (stage !== 4 || stack.length > 0 || matrix === undefined || name === undefined)
    return undefined
  const [a, b, c, d, e, f] = matrix
  if (
    a === undefined ||
    b === undefined ||
    c === undefined ||
    d === undefined ||
    e === undefined ||
    f === undefined ||
    a <= 0 ||
    d <= 0 ||
    b !== 0 ||
    c !== 0 ||
    !nearlyEqual(a, pageWidth) ||
    !nearlyEqual(d, pageHeight) ||
    !nearlyEqual(e, left) ||
    !nearlyEqual(f, bottom)
  )
    return undefined
  return { name, width: a, height: d }
}

function pageBox(
  document: Document,
  page: Dict,
  key: 'MediaBox' | 'CropBox',
): [number, number, number, number] | undefined {
  const box = document.resolve(page.entries.get(key))
  if (!Array.isArray(box) || box.length !== 4) return undefined
  const values = box.map((entry) => document.resolve(entry))
  if (!values.every((value) => typeof value === 'number' && Number.isFinite(value)))
    return undefined
  return values as [number, number, number, number]
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-6 * Math.max(1, Math.abs(left), Math.abs(right))
}

function decodeEmbeddedImage(
  document: Document,
  stream: Stream,
  limits: PdfEmbeddedImageLimits,
): PdfEmbeddedImage | undefined {
  const dict = stream.dict
  const width = numberEntry(document, dict, 'Width')
  const height = numberEntry(document, dict, 'Height')
  if (
    width === undefined ||
    height === undefined ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    return undefined
  for (const key of ['SMask', 'Mask', 'Decode', 'DecodeParms', 'ImageMask', 'Interpolate']) {
    if (dict.entries.has(key)) return undefined
  }
  const maxDimension = Math.max(1, Math.floor(limits.maxDimension ?? 4096))
  const maxPixels = Math.max(
    1,
    Math.min(Math.floor(limits.maxPixels ?? 16_777_216), MAX_STREAM_BYTES),
  )
  const maxBytes = Math.max(0, Math.floor(limits.maxBytes ?? 12 * 1024 * 1024))
  if (width > maxDimension || height > maxDimension || width > Math.floor(maxPixels / height))
    return undefined
  const bits = numberEntry(document, dict, 'BitsPerComponent')
  const channels = colorChannels(document, dict)
  if (bits !== 8 || channels === undefined) return undefined
  const filters = filterNames(document, dict)
  const single = filters.length === 1 ? filters[0] : undefined
  if (single === 'DCTDecode' || single === 'DCT') {
    const data = stream.data
    if (data.byteLength > maxBytes || data.byteLength < 4) return undefined
    const jpeg = jpegDimensions(data)
    if (
      jpeg === undefined ||
      jpeg.width !== width ||
      jpeg.height !== height ||
      jpeg.components !== channels ||
      jpeg.width > maxDimension ||
      jpeg.height > maxDimension ||
      jpeg.width > Math.floor(maxPixels / jpeg.height)
    )
      return undefined
    return { data, mimeType: 'image/jpeg', width, height }
  }
  if (filters.length === 0 || single === 'FlateDecode' || single === 'Fl') {
    const expected = width * height * channels
    if (expected > MAX_STREAM_BYTES) return undefined
    const pixels = document.stream(stream)
    if (pixels.byteLength !== expected) return undefined
    const png = encodePng(width, height, channels, pixels)
    if (png.byteLength > maxBytes) return undefined
    return { data: png, mimeType: 'image/png', width, height }
  }
  return undefined
}

function jpegDimensions(
  data: Uint8Array,
): { width: number; height: number; components: number } | undefined {
  if (data[0] !== 0xff || data[1] !== 0xd8) return undefined
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ])
  let offset = 2
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return undefined
    while (data[offset] === 0xff) offset++
    const marker = data[offset++]
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker === 0xd9) return undefined
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    const length = ((data[offset] ?? 0) << 8) | (data[offset + 1] ?? 0)
    if (length < 2 || offset + length > data.length) return undefined
    if (startOfFrame.has(marker)) {
      const components = data[offset + 7]
      if (components === undefined || data[offset + 2] !== 8 || length !== 8 + components * 3)
        return undefined
      const height = ((data[offset + 3] ?? 0) << 8) | (data[offset + 4] ?? 0)
      const width = ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0)
      if (width < 1 || height < 1) return undefined
      return { width, height, components }
    }
    if (marker === 0xda) return undefined
    offset += length
  }
  return undefined
}

function numberEntry(document: Document, dict: Dict, key: string): number | undefined {
  const value = document.resolve(dict.entries.get(key))
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function filterNames(document: Document, dict: Dict): string[] {
  const filter = document.resolve(dict.entries.get('Filter'))
  const list = Array.isArray(filter) ? filter : filter === undefined ? [] : [filter]
  const names: string[] = []
  for (const entry of list) {
    const name = nameOf(document.resolve(entry))
    if (name === undefined) return ['?']
    names.push(name)
  }
  return names
}

function colorChannels(document: Document, dict: Dict): 1 | 3 | undefined {
  const space = document.resolve(dict.entries.get('ColorSpace'))
  if (!isName(space)) return undefined
  if (space.value === 'DeviceGray' || space.value === 'G') return 1
  if (space.value === 'DeviceRGB' || space.value === 'RGB') return 3
  // Calibrated/indexed/ICC data needs color conversion, so use whole-page rendering instead.
  return undefined
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const output = new Uint8Array(12 + data.length)
  writeUint32(output, 0, data.length)
  for (let index = 0; index < 4; index++) output[4 + index] = type.charCodeAt(index)
  output.set(data, 8)
  writeUint32(output, 8 + data.length, crc32(output.subarray(4, 8 + data.length)))
  return output
}

/** Minimal 8-bit grayscale/RGB PNG writer for decoded page rasters. */
function encodePng(width: number, height: number, channels: 1 | 3, pixels: Uint8Array): Uint8Array {
  const stride = width * channels
  const raw = new Uint8Array((stride + 1) * height)
  for (let row = 0; row < height; row++) {
    const target = row * (stride + 1)
    raw[target] = 0
    raw.set(pixels.subarray(row * stride, (row + 1) * stride), target + 1)
  }
  const header = new Uint8Array(13)
  writeUint32(header, 0, width)
  writeUint32(header, 4, height)
  header[8] = 8
  header[9] = channels === 3 ? 2 : 0
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}
