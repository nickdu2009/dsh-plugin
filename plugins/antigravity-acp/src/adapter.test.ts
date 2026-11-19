import {
  createUserMessage,
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { selectConfigs, type AcpSelectConfig } from './acp-config.js'
import type { AcpGateway, AcpRunRequest } from './acp-client.js'
import { AntigravityAdapter } from './adapter.js'
import type { AttachmentService, OfficeRenderer, PromptLimits } from './prompt.js'
import { PROVIDER, SubmissionRouter } from './router.js'

const catalog = selectConfigs([
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini',
    options: [
      { value: 'gemini', name: 'Gemini' },
      { value: 'claude', name: 'Claude', description: 'Third-party' },
      { value: 'plain', name: 'Plain model without thought levels' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'medium',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
    ],
  },
])

class MockGateway implements AcpGateway {
  readonly runs: AcpRunRequest[] = []
  stopReason = 'end_turn'
  failure: Error | undefined

  async catalogOptions(): Promise<readonly AcpSelectConfig[]> {
    return catalog
  }

  async resolveOptions(model: string): Promise<readonly AcpSelectConfig[]> {
    if (
      !catalog.some(
        (option) =>
          option.category === 'model' &&
          option.options.some((entry) => 'value' in entry && entry.value === model),
      )
    )
      throw new Error('unknown model')
    const models = catalog.find((option) => option.category === 'model')!
    const selected = { ...models, currentValue: model }
    return model === 'plain'
      ? [selected]
      : catalog.map((option) => (option.category === 'model' ? selected : option))
  }

  async run(request: AcpRunRequest): Promise<string> {
    this.runs.push(request)
    if (this.failure) throw this.failure
    request.onThought('thinking once')
    request.onText(
      `answer:${request.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('|')}`,
    )
    return this.stopReason
  }

  dispose(): void {}
}

const limits: PromptLimits = {
  maxPages: 2,
  maxPdfBytes: 1024 * 1024,
  maxPageTextChars: 1000,
  maxImages: 2,
  maxTotalImageBytes: 1024 * 1024,
  maxImageDimension: 1024,
  maxImagePixels: 1024 * 1024,
  maxPromptTextChars: 10_000,
}

const attachments: AttachmentService = {
  async *readFileStream(): AsyncIterable<Uint8Array> {
    throw new Error('unexpected file read')
  },
  async readImage(): Promise<{ data: Uint8Array }> {
    throw new Error('unexpected image read')
  },
}
const office: OfficeRenderer = {
  async renderImages(): Promise<{ images: [] }> {
    throw new Error('unexpected PDF render')
  },
}

function fixture(): {
  gateway: MockGateway
  router: SubmissionRouter
  adapter: AntigravityAdapter
} {
  const gateway = new MockGateway()
  const router = new SubmissionRouter()
  return {
    gateway,
    router,
    adapter: new AntigravityAdapter(gateway, router, attachments, office, limits, '/tmp'),
  }
}

function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function submit(
  adapter: AntigravityAdapter,
  router: SubmissionRouter,
  text: string,
  turn: number,
  reasoningEffort?: GenerateOptions['reasoningEffort'],
): Promise<StreamChunk[]> {
  const message = user(text)
  router.claim('dsh-session', turn, 1, 'claude', [message])
  const options = markAgentLoopRequest<GenerateOptions>({
    provider: PROVIDER,
    model: 'claude',
    messages: [message],
    sessionId: 'dsh-session' as GenerateOptions['sessionId'],
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  })
  router.authorize(options)
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

function textOf(chunks: readonly StreamChunk[]): string {
  return chunks.flatMap((chunk) => (chunk.type === 'text-delta' ? [chunk.text] : [])).join('\n')
}

describe('AntigravityAdapter', () => {
  it('publishes the actual model catalog, including third-party entries, without per-model warnings', async () => {
    const { adapter } = fixture()
    expect(adapter.providerInfo(PROVIDER).name).toBe('Antigravity (ACP)')
    const models = await adapter.listModels(PROVIDER)
    expect(models.map((model) => model.id)).toEqual(['gemini', 'claude', 'plain'])
    expect(models.every((model) => model.badge === undefined)).toBe(true)
    expect(models.every((model) => !model.description?.includes('not supported'))).toBe(true)
  })

  it('uses thought_level as native reasoning efforts and omits it for models with no levels', async () => {
    const { adapter } = fixture()
    const resolved = await adapter.resolveModel(PROVIDER, 'claude')
    expect(resolved.reasoning?.efforts.map((effort) => effort.id)).toEqual([
      'low',
      'medium',
      'high',
    ])
    expect(resolved.reasoning?.defaultEffort).toBe('medium')
    const plain = await adapter.resolveModel(PROVIDER, 'plain')
    expect(plain.reasoning).toBeUndefined()
  })

  it('sends two explicit submissions exactly once each, with no history or system prompt', async () => {
    const { adapter, gateway, router } = fixture()
    const first = await submit(
      adapter,
      router,
      'first input',
      1,
      'high' as GenerateOptions['reasoningEffort'],
    )
    const second = await submit(
      adapter,
      router,
      'second input',
      2,
      'high' as GenerateOptions['reasoningEffort'],
    )
    expect(gateway.runs).toHaveLength(2)
    expect(gateway.runs.map((run) => run.content)).toEqual([
      [{ type: 'text', text: 'first input' }],
      [{ type: 'text', text: 'second input' }],
    ])
    expect(gateway.runs.every((run) => run.model === 'claude' && run.thoughtLevel === 'high')).toBe(
      true,
    )
    expect(textOf(first)).toContain('source and limits')
    expect(textOf(second)).not.toContain('source and limits')
    expect(
      first.some((chunk) => chunk.type === 'reasoning-delta' && chunk.text === 'thinking once'),
    ).toBe(true)
  })

  it('reports refusal without changing models or retrying', async () => {
    const { adapter, gateway, router } = fixture()
    gateway.stopReason = 'refusal'
    const chunks = await submit(adapter, router, 'refuse this', 1)
    expect(gateway.runs).toHaveLength(1)
    expect(gateway.runs[0]?.model).toBe('claude')
    expect(textOf(chunks)).toContain('refused this request; no alternate model was tried')
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('reports configuration failure once and never resends a consumed request', async () => {
    const { adapter, gateway, router } = fixture()
    gateway.failure = Object.assign(new Error('mock configuration rejected'), {
      code: 'ACP_CONFIG_REJECTED',
    })
    const message = user('do not resend')
    router.claim('dsh-session', 1, 1, 'claude', [message])
    const options = markAgentLoopRequest<GenerateOptions>({
      provider: PROVIDER,
      model: 'claude',
      messages: [message],
      sessionId: 'dsh-session' as GenerateOptions['sessionId'],
    })
    router.authorize(options)
    const collect = async (): Promise<StreamChunk[]> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream(options)) chunks.push(chunk)
      return chunks
    }
    const first = await collect()
    const retry = await collect()
    expect(gateway.runs).toHaveLength(1)
    expect(first.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_CONFIG_REJECTED' } },
    })
    expect(retry.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'ACP_UNVERIFIED_REQUEST' } },
    })
  })

  it('does not forward ACP tool events as DSH tool calls', async () => {
    const { adapter, router } = fixture()
    const chunks = await submit(adapter, router, 'ordinary response', 1)
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === 'tool-call-delta' ||
          (chunk.type === 'block-start' && chunk.blockType === 'tool-call'),
      ),
    ).toBe(false)
  })
})
