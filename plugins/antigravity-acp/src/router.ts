import { createRequire } from 'node:module'
import { isAgentLoopRequest as isLocalAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, UserMessage } from '@deepseek-ai/dsh-llm'

/**
 * dsh-agent-loop and a directory-linked plugin can load distinct dsh-llm module
 * instances. Its marker is a module-local WeakSet, so resolve the Host's copy
 * as well as our own; never replace this origin check with shape/frozen checks.
 */
function isHostAgentLoopRequest(options: GenerateOptions, installAnchor?: string): boolean {
  if (!installAnchor) return false
  try {
    const hostRequire = createRequire(installAnchor)
    const hostLlm: unknown = hostRequire('@deepseek-ai/dsh-llm')
    if (
      typeof hostLlm !== 'object' ||
      hostLlm === null ||
      !('isAgentLoopRequest' in hostLlm) ||
      typeof hostLlm.isAgentLoopRequest !== 'function'
    )
      return false
    return hostLlm.isAgentLoopRequest(options) === true
  } catch {
    // Non-Electron unit tests cannot require app.asar; retain the local marker.
    return false
  }
}

function isAgentLoopRequest(options: GenerateOptions, installAnchor?: string): boolean {
  return isHostAgentLoopRequest(options, installAnchor) || isLocalAgentLoopRequest(options)
}

export const PROVIDER = 'antigravity-acp'

export interface ClaimedSubmission {
  readonly sessionId: string
  readonly turn: number
  readonly step: 1
  readonly model: string
  readonly messages: readonly UserMessage[]
}

export class RouteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'RouteError'
  }
}

/**
 * True when a request's trailing explicit user inputs carry exactly the claimed
 * submission ids. It holds above DSH's request projection and below it, where
 * the request has been copied but message ids are unchanged.
 */
function endsWithClaimedSubmissions(options: GenerateOptions, claim: ClaimedSubmission): boolean {
  const claimedIds = claim.messages.map((message) => message.id)
  const requestIds = options.messages
    .filter((message) => message.role === 'user' && message.source?.kind === 'user')
    .map((message) => message.id)
    .slice(-claimedIds.length)
  return (
    requestIds.length === claimedIds.length && requestIds.every((id, i) => id === claimedIds[i])
  )
}

/**
 * Correlates the pre-step's exact submissions with the original frozen
 * agent-loop GenerateOptions. Correlation is by Message.id because the loop
 * rebuilds the request from the durable log; claims stay one-shot with no
 * resend path.
 */
export class SubmissionRouter {
  private readonly claims = new Map<string, ClaimedSubmission>()
  private readonly authorized = new Map<string, ClaimedSubmission>()

  constructor(private readonly installAnchor?: string) {}

  claim(
    sessionId: string,
    turn: number,
    step: number,
    model: string,
    messages: readonly UserMessage[],
  ): ClaimedSubmission {
    if (step !== 1)
      throw new RouteError(
        'Antigravity ACP does not forward internal continuation steps.',
        'ACP_INTERNAL_STEP',
      )
    if (
      messages.length === 0 ||
      messages.some((message) => message.role !== 'user' || message.source.kind !== 'user')
    ) {
      throw new RouteError(
        'Antigravity ACP accepts only explicit user submissions.',
        'ACP_UNKNOWN_ORIGIN',
      )
    }
    const duplicate = this.claims.get(sessionId)
    if (duplicate !== undefined) {
      throw new RouteError(
        `An ACP submission is already claimed for DSH session ${sessionId}; it will not be resent.`,
        'ACP_DUPLICATE_SUBMISSION',
      )
    }
    const claim: ClaimedSubmission = { sessionId, turn, step: 1, model, messages: [...messages] }
    this.claims.set(sessionId, claim)
    return claim
  }

  release(claim: ClaimedSubmission): void {
    if (this.claims.get(claim.sessionId) === claim) this.claims.delete(claim.sessionId)
  }

  authorize(options: GenerateOptions): ClaimedSubmission {
    if (options.provider !== PROVIDER)
      throw new RouteError('The ACP router received another provider.', 'ACP_PROVIDER_MISMATCH')
    if (!isAgentLoopRequest(options, this.installAnchor))
      throw new RouteError(
        'The ACP request did not originate in the DSH agent loop.',
        'ACP_NOT_AGENT_LOOP',
      )
    const sessionId = options.sessionId
    if (sessionId === undefined)
      throw new RouteError('The ACP request has no DSH session identity.', 'ACP_UNKNOWN_SESSION')
    const claim = this.claims.get(sessionId)
    if (claim === undefined)
      throw new RouteError(
        'No unconsumed explicit submission matches this ACP request; it will not be sent.',
        'ACP_UNKNOWN_OR_DUPLICATE',
      )
    if (claim.model !== options.model)
      throw new RouteError(
        'The selected model changed after the submission was claimed.',
        'ACP_MODEL_MISMATCH',
      )
    // The frozen request is rebuilt from the durable log, so the object identities
    // captured at pre-step are not preserved. Message.id is, and it is unique per
    // submission: require the request's trailing explicit inputs to be exactly the
    // claimed ones, so neither history nor a substituted message can satisfy it.
    if (!endsWithClaimedSubmissions(options, claim)) {
      throw new RouteError(
        'The frozen request does not end with the exact claimed submissions.',
        'ACP_MESSAGE_MISMATCH',
      )
    }
    this.authorized.set(sessionId, claim)
    return claim
  }

  /**
   * Consume the claim authorized for this session. The adapter is handed a fresh
   * projection of the frozen request (file and tool projection copies it), so
   * neither object identity nor the loop marker survives to this boundary: the
   * claim was authorized above the projection and Message.id keeps the link.
   */
  consume(options: GenerateOptions): ClaimedSubmission {
    const sessionId = options.sessionId
    const claim = sessionId === undefined ? undefined : this.authorized.get(sessionId)
    if (claim === undefined || options.sessionId !== claim.sessionId) {
      throw new RouteError(
        'The ACP adapter received an unverified, duplicate, or stale request; no prompt was sent.',
        'ACP_UNVERIFIED_REQUEST',
      )
    }
    if (!endsWithClaimedSubmissions(options, claim)) {
      throw new RouteError(
        'The ACP adapter request does not end with the claimed submissions; no prompt was sent.',
        'ACP_MESSAGE_MISMATCH',
      )
    }
    this.authorized.delete(claim.sessionId)
    if (this.claims.get(claim.sessionId) !== claim)
      throw new RouteError('The ACP claim was superseded; no prompt was sent.', 'ACP_STALE_CLAIM')
    this.claims.delete(claim.sessionId)
    return claim
  }
}
