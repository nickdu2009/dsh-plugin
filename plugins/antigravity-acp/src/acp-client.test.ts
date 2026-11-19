import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpClient } from './acp-client.js'
import { configByCategory, configValues } from './acp-config.js'

const agentSource = String.raw`
let input = ''
let promptCount = 0
let cancelCount = 0
let selectedModel = 'gemini'
let selectedThought = 'medium'
let pendingPrompt
const modelOption = () => ({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: selectedModel, options: [
  { value: 'gemini', name: 'Gemini' },
  { value: 'claude', name: 'Claude', description: 'Third-party mock' },
  { value: 'plain', name: 'Plain' },
  { value: 'reject', name: 'Always rejected' },
] })
const thoughtOption = () => ({ id: 'thought_level', name: 'Thinking', category: 'thought_level', type: 'select', currentValue: selectedThought, options: [
  { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' },
] })
const options = () => selectedModel === 'plain' ? [modelOption()] : [modelOption(), thoughtOption()]
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const textOf = (content) => content.filter((part) => part.type === 'text').map((part) => part.text).join('|')
function respond(message) {
  const { id, method, params } = message
  if (method === 'initialize') {
    if (params.protocolVersion !== 1 || params.clientInfo.name !== 'DeepSeek Harness' || params.clientCapabilities.terminal !== false) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'bad initialize' } })
    } else send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'Mock Antigravity ACP Server', version: '1' } } })
  } else if (method === 'session/new') {
    if (!Array.isArray(params.mcpServers) || params.mcpServers.length !== 0) send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'MCP forbidden' } })
    else send({ jsonrpc: '2.0', id, result: { sessionId: 'mock-session', configOptions: options() } })
  } else if (method === 'session/set_config_option') {
    if (params.value === 'reject' || (params.configId === 'thought_level' && !['low', 'medium', 'high'].includes(params.value))) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'mock configuration refused' } })
      return
    }
    if (params.configId === 'model') selectedModel = params.value
    if (params.configId === 'thought_level') selectedThought = params.value
    send({ jsonrpc: '2.0', id, result: { configOptions: options() } })
  } else if (method === 'session/prompt') {
    promptCount++
    const text = textOf(params.prompt)
    if (text === 'inspect counts') {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'counts:' + promptCount + ':' + cancelCount } } } })
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
      return
    }
    if (text.includes('diagnostics split')) {
      process.stderr.write('{"token":"split')
      setTimeout(() => process.stderr.write('-placeholder-secret","password":"json-placeholder"}\n'), 30)
      pendingPrompt = { id }
      return
    }
    if (text.includes('exit now')) {
      process.stderr.write('untrusted process-exit diagnostic\n')
      process.exit(7)
    }
    if (text.includes('hang')) {
      process.stderr.write('agy: upstream quota token=supersecret123 exhausted\n')
      pendingPrompt = { id }
      return
    }
    if (text.includes('slow')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'slow started' } } } })
      pendingPrompt = { id }
      return
    }
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'mock thought' } } } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'tool_call', toolCallId: 'not-a-dsh-tool', title: 'ignored', kind: 'execute', status: 'completed', rawInput: {} } } })
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'mock-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'prompt:' + promptCount + ':' + selectedModel + ':' + selectedThought + ':' + text } } } })
    send({ jsonrpc: '2.0', id, result: { stopReason: text.includes('refuse') ? 'refusal' : 'end_turn' } })
  } else if (method === 'session/cancel') {
    cancelCount++
    if (pendingPrompt) {
      send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'cancelled' } })
      pendingPrompt = undefined
    }
  }
}
process.stdin.on('data', (chunk) => {
  input += chunk.toString('utf8')
  while (true) {
    const newline = input.indexOf('\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (line.trim()) respond(JSON.parse(line))
  }
})
`

let directory = ''
let executable = ''
let client: AcpClient | undefined

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-acp-mock-'))
  executable = join(directory, 'mock-agent')
  await writeFile(executable, `#!${process.execPath}\n${agentSource}`, { mode: 0o755 })
  client = new AcpClient(executable)
})

afterEach(async () => {
  client?.dispose()
  client = undefined
  await rm(directory, { recursive: true, force: true })
})

async function run(
  text: string,
  model = 'gemini',
  thoughtLevel?: string,
  signal?: AbortSignal,
): Promise<{ stop: string; text: string; thoughts: string }> {
  let output = ''
  let thoughts = ''
  const stop = await client!.run({
    sessionKey: 'dsh-session',
    cwd: directory,
    model,
    ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
    content: [{ type: 'text', text }],
    ...(signal !== undefined ? { signal } : {}),
    onText: (delta) => {
      output += delta
    },
    onThought: (delta) => {
      thoughts += delta
    },
  })
  return { stop, text: output, thoughts }
}

describe('AcpClient NDJSON stdio protocol v1', () => {
  it('initializes the official v1 shape and enumerates actual options including third-party models', async () => {
    const options = await client!.catalogOptions()
    expect(configValues(configByCategory(options, 'model')!).map((entry) => entry.value)).toEqual([
      'gemini',
      'claude',
      'plain',
      'reject',
    ])
    expect(
      configValues(configByCategory(options, 'thought_level')!).map((entry) => entry.value),
    ).toEqual(['low', 'medium', 'high'])
  })

  it('applies model/thought selections from complete returned options and sends one prompt', async () => {
    const result = await run('hello', 'claude', 'high')
    expect(result.stop).toBe('end_turn')
    expect(result.text).toBe('prompt:1:claude:high:hello')
    expect(result.thoughts).toBe('mock thought')
    const refreshed = await client!.resolveOptions('plain')
    expect(configByCategory(refreshed, 'thought_level')).toBeUndefined()
  })

  it('does not prompt or fall back when model configuration is refused', async () => {
    await expect(run('must not send', 'reject')).rejects.toThrow('mock configuration refused')
    const next = await run('next explicit input')
    expect(next.text).toBe('prompt:1:gemini:medium:next explicit input')
  })

  it('does not prompt for an unadvertised thought level and reports refusals without fallback', async () => {
    await expect(run('must not send', 'gemini', 'invalid')).rejects.toThrow(
      'does not advertise thought level',
    )
    const refusal = await run('refuse')
    expect(refusal.stop).toBe('refusal')
    expect(refusal.text).toBe('prompt:1:gemini:medium:refuse')
  })

  it('cancels promptly, ignores the late result, and never resends the cancelled input', async () => {
    const controller = new AbortController()
    let markStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const pending = client!.run({
      sessionKey: 'dsh-session',
      cwd: directory,
      model: 'gemini',
      content: [{ type: 'text', text: 'slow input' }],
      signal: controller.signal,
      onText: () => {},
      onThought: (text) => {
        if (text === 'slow started') markStarted?.()
      },
    })
    await started
    controller.abort(new Error('test cancellation'))
    await expect(pending).rejects.toThrow('test cancellation')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const next = await run('after cancellation')
    expect(next.text).toBe('prompt:2:gemini:medium:after cancellation')
    const counts = await run('inspect counts')
    expect(counts.text).toBe('counts:3:1')
  })

  it('fails one silent prompt and disarms its timer before the next submission', async () => {
    client!.dispose()
    client = new AcpClient(executable, undefined, { idleTimeoutMs: 150 })
    const startedAt = Date.now()
    const failure = await run('hang forever').catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('sent no ACP traffic')
    expect((failure as { code?: string }).code).toBe('ACP_NO_RESPONSE')
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    await new Promise((resolve) => setTimeout(resolve, 240))
    const counts = await run('inspect counts')
    expect(counts.text).toBe('counts:2:1')
  })

  it('cleans up normal completion and process-exit timers without stale cancels or resends', async () => {
    client!.dispose()
    client = new AcpClient(executable, undefined, { idleTimeoutMs: 150 })
    const controller = new AbortController()
    await run('already complete', 'gemini', undefined, controller.signal)
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 240))
    const afterNormal = await run('inspect counts')
    expect(afterNormal.text).toBe('counts:2:0')
    const exitFailure = (await run('exit now').catch((error: Error) => error)) as Error & {
      code?: string
    }
    expect(exitFailure.code).toBe('ACP_PROCESS')
    expect(exitFailure.message).not.toContain('untrusted process-exit diagnostic')
    await new Promise((resolve) => setTimeout(resolve, 240))
    const counts = await run('inspect counts')
    // The new explicit input starts a fresh process; no old timer/cancel survives the exit.
    expect(counts.text).toBe('counts:1:0')
  })

  it('suppresses raw stderr instead of forwarding token-shaped diagnostics', async () => {
    client!.dispose()
    client = new AcpClient(executable, undefined, { idleTimeoutMs: 150 })
    const failure = (await run('hang forever').catch((error: Error) => error)) as Error
    expect(failure.message).toContain('unrecognized content was suppressed')
    expect(failure.message).not.toContain('supersecret123')
    expect(failure.message).not.toContain('quota')
    expect(client!.lastDiagnostics()).toEqual([
      'agy emitted stderr; its unrecognized content was suppressed.',
    ])
  })

  it('does not expose quoted JSON or values split across stderr chunks', async () => {
    client!.dispose()
    client = new AcpClient(executable, undefined, { idleTimeoutMs: 180 })
    const failure = (await run('diagnostics split hang').catch((error: Error) => error)) as Error
    const visible = `${failure.message}\n${client!.lastDiagnostics().join('\n')}`
    expect(visible).toContain('unrecognized content was suppressed')
    expect(visible).not.toContain('split-placeholder-secret')
    expect(visible).not.toContain('json-placeholder')
    expect(visible).not.toContain('{"token"')
  })
})
