import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createUserMessage,
  isAgentLoopRequest as isLocalAgentLoopRequest,
  markAgentLoopRequest,
  type GenerateOptions,
  type UserMessage,
} from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { PROVIDER, RouteError, SubmissionRouter } from './router.js'

function user(text: string, kind: 'user' | 'system-prompt' = 'user'): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind } })
}

function request(
  messages: readonly UserMessage[],
  sessionId = 'session-1',
  marked = true,
): GenerateOptions {
  const options: GenerateOptions = {
    provider: PROVIDER,
    model: 'gemini',
    messages: [...messages],
    sessionId: sessionId as GenerateOptions['sessionId'],
  }
  return marked ? markAgentLoopRequest(options) : options
}

function code(error: unknown): string {
  return error instanceof RouteError ? error.code : String(error)
}

describe('SubmissionRouter', () => {
  it('requires step one, explicit user origin, and a marked agent-loop request', () => {
    const router = new SubmissionRouter()
    const message = user('one')
    expect(() => router.claim('session-1', 1, 2, 'gemini', [message])).toThrowError(
      expect.objectContaining({ code: 'ACP_INTERNAL_STEP' }),
    )
    expect(() =>
      router.claim('session-1', 1, 1, 'gemini', [user('title', 'system-prompt')]),
    ).toThrowError(expect.objectContaining({ code: 'ACP_UNKNOWN_ORIGIN' }))
    router.claim('session-1', 1, 1, 'gemini', [message])
    expect(() => router.authorize(request([message], 'session-1', false))).toThrowError(
      expect.objectContaining({ code: 'ACP_NOT_AGENT_LOOP' }),
    )
  })

  it('rejects duplicate, unknown, wrong-session, wrong-model, and substituted-message requests', () => {
    const router = new SubmissionRouter()
    const message = user('one')
    router.claim('session-1', 1, 1, 'gemini', [message])
    try {
      router.claim('session-1', 2, 1, 'gemini', [user('two')])
    } catch (error) {
      expect(code(error)).toBe('ACP_DUPLICATE_SUBMISSION')
    }
    expect(() => router.authorize(request([message], 'other'))).toThrowError(
      expect.objectContaining({ code: 'ACP_UNKNOWN_OR_DUPLICATE' }),
    )
    expect(() => router.authorize({ ...request([message]), model: 'other' })).toThrowError(
      expect.objectContaining({ code: 'ACP_NOT_AGENT_LOOP' }),
    )
    const marked = request([message])
    expect(() => router.authorize({ ...marked, model: 'other' })).toThrowError(
      expect.objectContaining({ code: 'ACP_NOT_AGENT_LOOP' }),
    )
    expect(() => router.authorize(request([user('substitute')]))).toThrowError(
      expect.objectContaining({ code: 'ACP_MESSAGE_MISMATCH' }),
    )
  })

  it('authorizes a durable-log rebuild that preserves message id but not object identity', () => {
    const router = new SubmissionRouter()
    const submitted = user('rebuilt')
    router.claim('session-1', 1, 1, 'gemini', [submitted])
    const rebuilt = structuredClone(submitted) as UserMessage
    expect(rebuilt).not.toBe(submitted)
    expect(rebuilt.id).toBe(submitted.id)
    const rebuiltRequest = request([rebuilt])
    expect(router.authorize(rebuiltRequest).messages[0]?.id).toBe(submitted.id)
    expect(router.consume(rebuiltRequest).messages).toEqual([submitted])
  })

  it('rejects a request whose trailing explicit input is not the claimed submission', () => {
    const router = new SubmissionRouter()
    const submitted = user('claimed')
    router.claim('session-1', 1, 1, 'gemini', [submitted])
    expect(() => router.authorize(request([submitted, user('injected')]))).toThrowError(
      expect.objectContaining({ code: 'ACP_MESSAGE_MISMATCH' }),
    )
  })

  it('consumes the projected copy the adapter receives, which no longer carries the loop marker', () => {
    const router = new SubmissionRouter()
    const submitted = user('projected')
    router.claim('session-1', 1, 1, 'gemini', [submitted])
    const marked = request([submitted])
    router.authorize(marked)
    const projected = {
      ...marked,
      messages: [structuredClone(submitted) as UserMessage],
    }
    expect(isLocalAgentLoopRequest(projected)).toBe(false)
    expect(router.consume(projected).messages[0]?.id).toBe(submitted.id)
  })

  it('rejects a projected copy whose trailing explicit input was swapped', () => {
    const router = new SubmissionRouter()
    const submitted = user('projected')
    router.claim('session-1', 1, 1, 'gemini', [submitted])
    const marked = request([submitted])
    router.authorize(marked)
    expect(() =>
      router.consume({ ...marked, messages: [submitted, user('swapped')] }),
    ).toThrowError(expect.objectContaining({ code: 'ACP_MESSAGE_MISMATCH' }))
  })

  it('atomically consumes each explicit submission once and permits the next explicit turn', () => {
    const router = new SubmissionRouter()
    const first = user('first')
    const firstRequest = request([first])
    router.claim('session-1', 1, 1, 'gemini', [first])
    router.authorize(firstRequest)
    expect(router.consume(firstRequest).messages).toEqual([first])
    expect(() => router.consume(firstRequest)).toThrowError(
      expect.objectContaining({ code: 'ACP_UNVERIFIED_REQUEST' }),
    )
    expect(() => router.authorize(firstRequest)).toThrowError(
      expect.objectContaining({ code: 'ACP_UNKNOWN_OR_DUPLICATE' }),
    )

    const second = user('second')
    const secondRequest = request([second])
    router.claim('session-1', 2, 1, 'gemini', [second])
    router.authorize(secondRequest)
    expect(router.consume(secondRequest).messages[0]?.content).toEqual([
      { type: 'text', text: 'second' },
    ])
  })

  it('does not authorize an unmarked model mismatch even when fields otherwise match', () => {
    const router = new SubmissionRouter()
    const message = user('one')
    const marked = request([message])
    router.claim('session-1', 1, 1, 'gemini', [message])
    const mismatched = Object.assign(marked, { model: 'other' })
    expect(() => router.authorize(mismatched)).toThrowError(
      expect.objectContaining({ code: 'ACP_MODEL_MISMATCH' }),
    )
  })

  it('uses the Host marker from a distinct physical copy without weakening one-shot checks', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'antigravity-acp-host-'))
    const hostInstallDir = join(temporary, 'node_modules', '@deepseek-ai', 'dsh')
    const hostPackageDir = join(temporary, 'node_modules', '@deepseek-ai', 'dsh-llm')
    await mkdir(hostInstallDir, { recursive: true })
    await mkdir(hostPackageDir, { recursive: true })
    await writeFile(
      join(hostInstallDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' }),
    )
    await writeFile(
      join(hostPackageDir, 'package.json'),
      JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.cjs' }),
    )
    await writeFile(
      join(hostPackageDir, 'index.cjs'),
      'const requests = new WeakSet(); exports.markAgentLoopRequest = (request) => { requests.add(request); return request }; exports.isAgentLoopRequest = (request) => requests.has(request);\n',
    )
    const hostRequire = createRequire(join(hostInstallDir, 'package.json'))
    const hostLlm = hostRequire('@deepseek-ai/dsh-llm') as {
      markAgentLoopRequest(options: GenerateOptions): GenerateOptions
    }
    const previousInstallDir = process.env.DSH_INSTALL_DIR
    process.env.DSH_INSTALL_DIR = hostInstallDir
    try {
      const router = new SubmissionRouter()
      const message = user('host-marked')
      const marked = request([message], 'host-session', false)
      hostLlm.markAgentLoopRequest(marked)
      expect(isLocalAgentLoopRequest(marked)).toBe(false)
      router.claim('host-session', 1, 1, 'gemini', [message])
      router.authorize(marked)
      expect(router.consume(marked).messages).toEqual([message])
      expect(() => router.consume(marked)).toThrowError(
        expect.objectContaining({ code: 'ACP_UNVERIFIED_REQUEST' }),
      )

      const unmarkedMessage = user('unmarked')
      router.claim('unmarked-session', 1, 1, 'gemini', [unmarkedMessage])
      expect(() =>
        router.authorize(request([unmarkedMessage], 'unmarked-session', false)),
      ).toThrowError(expect.objectContaining({ code: 'ACP_NOT_AGENT_LOOP' }))

      const copiedMessage = user('copied')
      const original = request([copiedMessage], 'copied-session', false)
      hostLlm.markAgentLoopRequest(original)
      router.claim('copied-session', 1, 1, 'gemini', [copiedMessage])
      expect(() => router.authorize({ ...original })).toThrowError(
        expect.objectContaining({ code: 'ACP_NOT_AGENT_LOOP' }),
      )
    } finally {
      if (previousInstallDir === undefined) delete process.env.DSH_INSTALL_DIR
      else process.env.DSH_INSTALL_DIR = previousInstallDir
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
