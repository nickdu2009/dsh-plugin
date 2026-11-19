import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { hasConfigValue, selectConfigs, type AcpSelectConfig } from './acp-config.js'

export type AcpPromptContent =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      data: string
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    }

export type AcpStopReason = 'end_turn' | 'max_tokens' | 'cancelled' | 'refusal' | string

export interface AcpRunRequest {
  sessionKey: string
  cwd: string
  model: string
  thoughtLevel?: string
  content: readonly AcpPromptContent[]
  signal?: AbortSignal
  onText(text: string): void
  onThought(text: string): void
}

export interface AcpClientOptions {
  /**
   * Reject one prompt that receives no ACP traffic for this long, so a silent
   * CLI cannot wedge a chat turn forever. 0 disables the watchdog.
   */
  idleTimeoutMs?: number
  /** Retain only a fixed stderr-observed notice; raw stderr is never stored. */
  diagnosticLines?: number
}

/** Backend seam used by the adapter; tests replace this with a strict mock. */
export interface AcpGateway {
  catalogOptions(signal?: AbortSignal): Promise<readonly AcpSelectConfig[]>
  resolveOptions(model: string, signal?: AbortSignal): Promise<readonly AcpSelectConfig[]>
  run(request: AcpRunRequest): Promise<AcpStopReason>
  dispose(): void
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface PendingRequest {
  method: string
  resolve(value: unknown): void
  reject(error: Error): void
}

const STDERR_NOTICE = 'agy emitted stderr; its unrecognized content was suppressed.'

export class AcpProtocolError extends Error {
  constructor(
    message: string,
    readonly code = 'ACP_PROTOCOL',
  ) {
    super(message)
    this.name = 'AcpProtocolError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('The ACP request was cancelled.')
}

/**
 * One official `agy acp --stdio` process. It deliberately offers no filesystem,
 * terminal, or MCP capability and declines every agent permission request.
 */
export class AcpClient implements AcpGateway {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private input = Buffer.alloc(0)
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly sessions = new Map<string, string>()
  private readonly sessionOptions = new Map<string, AcpSelectConfig[]>()
  private readonly listeners = new Map<string, AcpRunRequest>()
  private initializePromise: Promise<void> | undefined
  private catalogSessionPromise: Promise<string> | undefined
  private catalog: AcpSelectConfig[] = []
  private disposed = false
  private queue: Promise<unknown> = Promise.resolve()
  private lastInboundAt = 0
  private readonly diagnostics: string[] = []
  private readonly idleTimeoutMs: number
  private readonly diagnosticLines: number

  constructor(
    readonly executable = 'agy',
    readonly clientVersion = '0.2.2-rc.5',
    readonly options: AcpClientOptions = {},
  ) {
    this.idleTimeoutMs = Math.max(0, options.idleTimeoutMs ?? 90_000)
    this.diagnosticLines = Math.max(0, options.diagnosticLines ?? 8)
  }

  /** Fixed diagnostic classifications only; raw CLI stderr is never retained. */
  lastDiagnostics(): readonly string[] {
    return [...this.diagnostics]
  }

  async catalogOptions(signal?: AbortSignal): Promise<readonly AcpSelectConfig[]> {
    await this.ensureCatalog(signal)
    return this.catalog
  }

  async resolveOptions(model: string, signal?: AbortSignal): Promise<readonly AcpSelectConfig[]> {
    const sessionId = await this.ensureCatalog(signal)
    return this.exclusive(sessionId, async () => {
      this.catalog = await this.selectModel(sessionId, model, this.catalog, signal)
      return this.catalog
    })
  }

  async run(request: AcpRunRequest): Promise<AcpStopReason> {
    if (this.disposed) throw new AcpProtocolError('The ACP client is disposed.', 'ACP_DISPOSED')
    request.signal?.throwIfAborted()
    await this.initialize(request.signal)
    const sessionId = await this.sessionFor(request.sessionKey, request.cwd, request.signal)
    return this.exclusive(sessionId, async () => {
      request.signal?.throwIfAborted()
      let options = this.sessionOptions.get(sessionId) ?? []
      options = await this.selectModel(sessionId, request.model, options, request.signal)
      if (request.thoughtLevel !== undefined) {
        const thought = options.find((option) => option.category === 'thought_level')
        if (thought === undefined) {
          throw new AcpProtocolError(
            `Model "${request.model}" does not advertise a thought_level option.`,
            'ACP_UNSUPPORTED_THOUGHT_LEVEL',
          )
        }
        if (!hasConfigValue(thought, request.thoughtLevel)) {
          throw new AcpProtocolError(
            `Model "${request.model}" does not advertise thought level "${request.thoughtLevel}".`,
            'ACP_UNSUPPORTED_THOUGHT_LEVEL',
          )
        }
        if (thought.currentValue !== request.thoughtLevel) {
          const result = await this.request(
            'session/set_config_option',
            {
              sessionId,
              configId: thought.id,
              value: request.thoughtLevel,
            },
            request.signal,
          )
          options = this.requireFullOptions(result)
          this.sessionOptions.set(sessionId, options)
        }
      }
      // Configuration failures above reject before session/prompt: no fallback and no send.
      request.signal?.throwIfAborted()
      this.listeners.set(sessionId, request)
      try {
        const result = await this.request(
          'session/prompt',
          { sessionId, prompt: request.content },
          request.signal,
          {
            timeoutMs: this.idleTimeoutMs,
            onAbort: () => {
              this.notify('session/cancel', { sessionId }).catch(() => {})
            },
            onIdleTimeout: () => {
              this.notify('session/cancel', { sessionId }).catch(() => {})
            },
          },
        )
        if (request.signal?.aborted) throw abortError(request.signal)
        if (
          typeof result !== 'object' ||
          result === null ||
          !('stopReason' in result) ||
          typeof result.stopReason !== 'string'
        ) {
          throw new AcpProtocolError(
            'ACP session/prompt returned no recognized stopReason; the input will not be resent.',
            'ACP_UNKNOWN_RESULT',
          )
        }
        return result.stopReason
      } finally {
        if (this.listeners.get(sessionId) === request) this.listeners.delete(sessionId)
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    this.child = undefined
    const error = new AcpProtocolError(
      'The ACP client was disposed; unfinished prompts will not be retried.',
      'ACP_DISPOSED',
    )
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
    child?.kill()
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new AcpProtocolError('The ACP client is disposed.', 'ACP_DISPOSED')
    if (this.initializePromise === undefined) {
      const initializing = (async () => {
        this.start()
        const result = await this.request(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false,
            },
            clientInfo: {
              name: 'DeepSeek Harness',
              title: 'DeepSeek Harness',
              version: this.clientVersion,
            },
          },
          signal,
        )
        if (
          typeof result !== 'object' ||
          result === null ||
          !('protocolVersion' in result) ||
          result.protocolVersion !== 1
        ) {
          throw new AcpProtocolError('agy did not accept ACP protocol v1.', 'ACP_PROTOCOL_VERSION')
        }
      })()
      this.initializePromise = initializing
      initializing.catch(() => {
        // Initialization has a one-shot lifecycle; a later explicit submission starts a fresh process.
        if (this.initializePromise === initializing) {
          this.initializePromise = undefined
          const child = this.child
          this.child = undefined
          child?.kill()
        }
      })
    }
    return this.initializePromise
  }

  private async ensureCatalog(signal?: AbortSignal): Promise<string> {
    await this.initialize(signal)
    if (this.catalogSessionPromise === undefined) {
      const creating = (async () => {
        const key = '@catalog'
        const sessionId = await this.newSession(process.cwd(), signal)
        this.sessions.set(key, sessionId)
        this.catalog = this.sessionOptions.get(sessionId) ?? []
        return sessionId
      })()
      this.catalogSessionPromise = creating
      creating.catch(() => {
        if (this.catalogSessionPromise === creating) this.catalogSessionPromise = undefined
      })
    }
    const sessionId = await this.catalogSessionPromise
    this.catalog = this.sessionOptions.get(sessionId) ?? this.catalog
    return sessionId
  }

  private async sessionFor(key: string, cwd: string, signal?: AbortSignal): Promise<string> {
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const sessionId = await this.newSession(cwd, signal)
    this.sessions.set(key, sessionId)
    return sessionId
  }

  private async newSession(cwd: string, signal?: AbortSignal): Promise<string> {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, signal)
    if (
      typeof result !== 'object' ||
      result === null ||
      !('sessionId' in result) ||
      typeof result.sessionId !== 'string'
    ) {
      throw new AcpProtocolError('ACP session/new returned no sessionId.', 'ACP_UNKNOWN_RESULT')
    }
    const options = 'configOptions' in result ? selectConfigs(result.configOptions) : []
    this.sessionOptions.set(result.sessionId, options)
    return result.sessionId
  }

  private async selectModel(
    sessionId: string,
    model: string,
    current: readonly AcpSelectConfig[],
    signal?: AbortSignal,
  ): Promise<AcpSelectConfig[]> {
    const option = current.find((entry) => entry.category === 'model')
    if (option === undefined)
      throw new AcpProtocolError('agy advertised no ACP model config option.', 'ACP_NO_MODELS')
    if (option.currentValue === model) return [...current]
    const result = await this.request(
      'session/set_config_option',
      { sessionId, configId: option.id, value: model },
      signal,
    )
    const refreshed = this.requireFullOptions(result)
    this.sessionOptions.set(sessionId, refreshed)
    return refreshed
  }

  private requireFullOptions(result: unknown): AcpSelectConfig[] {
    if (typeof result !== 'object' || result === null || !('configOptions' in result)) {
      throw new AcpProtocolError(
        'ACP set_config_option did not return the complete configOptions list; refusing a partial update.',
        'ACP_PARTIAL_CONFIG',
      )
    }
    return selectConfigs(result.configOptions)
  }

  private rememberDiagnostic(_chunk: Buffer): void {
    if (this.diagnosticLines === 0 || this.diagnostics.length > 0) return
    // Do not retain, split, sanitize, or interpolate unrecognized stderr. A fixed
    // classification cannot leak secrets hidden in JSON or across chunk boundaries.
    this.diagnostics.push(STDERR_NOTICE)
  }

  private diagnosticSuffix(): string {
    return this.diagnostics.length === 0 ? '' : ` ${STDERR_NOTICE}`
  }

  private start(): void {
    if (this.child !== undefined) return
    const child = spawn(this.executable, ['acp', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env,
    })
    this.child = child
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.child === child) this.receive(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (this.child === child) this.rememberDiagnostic(chunk)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      this.fail(
        new AcpProtocolError(`Unable to start official agy ACP: ${error.message}`, 'ACP_PROCESS'),
      )
    })
    child.on('close', (code) => {
      if (this.child !== child || this.disposed) return
      this.fail(
        new AcpProtocolError(
          `agy ACP exited (${code ?? 'unknown'}); unfinished prompts will not be retried.${this.diagnosticSuffix()}`,
          'ACP_PROCESS',
        ),
      )
    })
  }

  private fail(error: Error): void {
    const child = this.child
    this.child = undefined
    child?.kill()
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.listeners.clear()
    this.sessions.clear()
    this.sessionOptions.clear()
    this.input = Buffer.alloc(0)
    this.initializePromise = undefined
    this.catalogSessionPromise = undefined
  }

  private receive(chunk: Buffer): void {
    this.lastInboundAt = Date.now()
    this.input = Buffer.concat([this.input, chunk])
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) {
        if (this.input.length > 32 * 1024 * 1024)
          this.fail(
            new AcpProtocolError('ACP message exceeds the 32 MiB frame limit.', 'ACP_FRAMING'),
          )
        return
      }
      const body = this.input.subarray(0, newline).toString('utf8').trim()
      this.input = this.input.subarray(newline + 1)
      if (!body) continue
      if (Buffer.byteLength(body, 'utf8') > 32 * 1024 * 1024) {
        this.fail(
          new AcpProtocolError('ACP message exceeds the 32 MiB frame limit.', 'ACP_FRAMING'),
        )
        return
      }
      let message: unknown
      try {
        message = JSON.parse(body)
      } catch (error) {
        this.fail(new AcpProtocolError(`Invalid ACP NDJSON: ${errorMessage(error)}`, 'ACP_FRAMING'))
        return
      }
      this.handleMessage(message)
    }
  }

  private handleMessage(message: unknown): void {
    if (typeof message !== 'object' || message === null) return
    if ('id' in message && (typeof message.id === 'number' || typeof message.id === 'string')) {
      const pending = this.pending.get(message.id)
      if (pending === undefined) return
      if ('method' in message && typeof message.method === 'string') {
        this.handleAgentRequest(
          message.id,
          message.method,
          'params' in message ? message.params : undefined,
        )
        return
      }
      if ('error' in message && message.error !== undefined) {
        const detail = message.error as { code?: number; message?: string }
        pending.reject(
          new AcpProtocolError(
            `${pending.method} refused: ${detail.message ?? 'unknown JSON-RPC error'}`,
            'ACP_REFUSED',
          ),
        )
      } else {
        pending.resolve('result' in message ? message.result : undefined)
      }
      return
    }
    if (!('method' in message) || typeof message.method !== 'string') return
    const notification = message as JsonRpcNotification
    if (notification.method !== 'session/update') return
    const params = notification.params
    if (
      typeof params !== 'object' ||
      params === null ||
      !('sessionId' in params) ||
      typeof params.sessionId !== 'string' ||
      !('update' in params)
    )
      return
    const update = params.update
    if (typeof update !== 'object' || update === null || !('sessionUpdate' in update)) return
    if (update.sessionUpdate === 'config_option_update' && 'configOptions' in update) {
      this.sessionOptions.set(params.sessionId, selectConfigs(update.configOptions))
      if (this.sessions.get('@catalog') === params.sessionId)
        this.catalog = selectConfigs(update.configOptions)
      return
    }
    const listener = this.listeners.get(params.sessionId)
    if (
      listener === undefined ||
      !('content' in update) ||
      typeof update.content !== 'object' ||
      update.content === null
    )
      return
    const content = update.content
    if (!('text' in content) || typeof content.text !== 'string') return
    if (update.sessionUpdate === 'agent_message_chunk') listener.onText(content.text)
    if (update.sessionUpdate === 'agent_thought_chunk') listener.onThought(content.text)
    // tool_call/tool_call_update/plan and every other event stay inside ACP; none become DSH tool calls.
  }

  private handleAgentRequest(id: number | string, method: string, _params: unknown): void {
    if (method === 'session/request_permission') {
      this.write({ jsonrpc: '2.0', id, result: { outcome: { outcome: 'cancelled' } } })
      return
    }
    this.write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `DeepSeek Harness does not expose ${method} to ACP.` },
    })
  }

  private request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    idle?: { timeoutMs: number; onAbort?(): void; onIdleTimeout?(): void },
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError(signal))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      let settled = false
      let idleTimer: ReturnType<typeof setInterval> | undefined
      const cleanup = (): void => {
        if (idleTimer !== undefined) clearInterval(idleTimer)
        idleTimer = undefined
        signal?.removeEventListener('abort', abort)
      }
      const finish = (): boolean => {
        if (settled) return false
        settled = true
        this.pending.delete(id)
        cleanup()
        return true
      }
      const succeed = (value: unknown): void => {
        if (finish()) resolve(value)
      }
      const fail = (error: Error): void => {
        if (finish()) reject(error)
      }
      const abort = (): void => {
        if (settled) return
        // Only a still-pending session/prompt supplies this callback. Once any
        // terminal event settles the request, later aborts cannot send cancel.
        try {
          idle?.onAbort?.()
        } catch {
          // Cancellation is best-effort; preserve the caller's abort reason.
        }
        fail(abortError(signal as AbortSignal))
      }
      if (idle !== undefined && idle.timeoutMs > 0) {
        const startedAt = Date.now()
        this.lastInboundAt = startedAt
        const tick = Math.max(20, Math.min(1000, Math.floor(idle.timeoutMs / 3)))
        idleTimer = setInterval(() => {
          if (settled || Date.now() - this.lastInboundAt < idle.timeoutMs) return
          const error = new AcpProtocolError(
            `agy accepted ${method} but sent no ACP traffic for ${Math.round(
              (Date.now() - startedAt) / 1000,
            )}s; the input was not resent.${this.diagnosticSuffix()}`,
            'ACP_NO_RESPONSE',
          )
          try {
            idle.onIdleTimeout?.()
          } catch {
            // The fixed timeout error remains authoritative if cancel cannot be written.
          }
          fail(error)
        }, tick)
        idleTimer.unref?.()
      }
      this.pending.set(id, { method, resolve: succeed, reject: fail })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.write({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private async notify(method: string, params: unknown): Promise<void> {
    this.write({ jsonrpc: '2.0', method, params })
  }

  private write(message: JsonRpcResponse | JsonRpcNotification | Record<string, unknown>): void {
    if (this.child === undefined)
      throw new AcpProtocolError('agy ACP is not running.', 'ACP_PROCESS')
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    this.child.stdin.write(`${body.toString('utf8')}\n`)
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    // A per-process queue also protects the discovery session from concurrent model probes.
    const result = this.queue.then(operation, operation)
    this.queue = result.catch(() => {})
    return result
  }
}
