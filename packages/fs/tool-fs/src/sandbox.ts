/**
 * The sandbox-escalation API shared by the `write` and `edit` tools: the
 * per-call policy resolution, the advertised escalation fields, and the denial-marker
 * mapping — all delegating the vocabulary and the fail-closed approval
 * sequence to `@deepseek-ai/dsh-sandbox` (the same pieces `@deepseek-ai/dsh-tool-bash`
 * uses), so bash and fs escalate identically. Built ONCE per plugin from
 * `ctx.fs.sandboxMode` (the capability fact — is a confining backend mounted?)
 * and shared by both mutating tools.
 *
 * @module @deepseek-ai/dsh-tool-fs/sandbox
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  ESCALATION_TARGETS,
  approveEscalation,
  escalationHintMarker,
  sandboxDenialMarker,
  validateEscalationArgs,
  withoutEscalationSchema,
} from '@deepseek-ai/dsh-sandbox'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { FsError } from '@deepseek-ai/dsh-fs'

/** The two escalation arguments a mutating tool may carry when the assembled session can ask for escalation. */
export interface FsEscalationArgs {
  sandbox_permissions?: string
  justification?: string
}

/** The registered escalation fields; prompt assembly removes them when the current session cannot ask. */
export interface EscalationSchemaFields {
  sandbox_permissions: { type: 'string'; enum: string[]; description: string }
  justification: { type: 'string'; description: string }
}

/**
 * The filesystem escalation API: advertisement gating, per-call policy
 * resolution, the one-approved wider retry, and denial-marker mapping. A pure
 * product of `ctx` at plugin apply time.
 */
export class FsSandboxController {
  /** The escalation targets supported by this composition (`[]` when no confining backend is mounted). */
  readonly escalationModes: readonly SandboxMode[]
  /** Shared per-session policy resolver, required by a confining backend. */
  private readonly policy: SandboxPolicyService | undefined

  constructor(private readonly ctx: Context) {
    const defaultMode = ctx.fs.sandboxMode
    this.escalationModes = defaultMode === undefined ? [] : ESCALATION_TARGETS
    this.policy = defaultMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (defaultMode !== undefined && this.policy === undefined) {
      throw new Error('tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
    if (this.escalationModes.length > 0) {
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembled = await next()
        const agent = context.agent
        if (agent === undefined) return assembled
        const policy = this.policy?.resolve({ session: agent.session })
        if (this.canEscalate(agent, policy)) return assembled
        return {
          ...assembled,
          tools: assembled.tools.map(tool =>
            tool.name === 'write' || tool.name === 'edit' ? withoutEscalationSchema(tool) : tool),
        }
      })
    }
  }

  private canEscalate(
    agent: ToolExecution['agent'],
    policy: SandboxExecutionPolicy | undefined,
  ): boolean {
    if (this.escalationModes.length === 0 || agent === undefined || policy?.mode === 'danger-full-access') {
      return false
    }
    return this.ctx.get('approval')?.effectivePolicy(agent.session) === 'ask'
  }

  /**
   * The escalation schema fields for a mutating tool's `parameters`. Call it
   * only under a confining backend (guard on {@link escalationModes}); the
   * enum pins the closed target vocabulary, the strict-wider check happens per
   * call at execution.
   * @returns the two escalation parameter specs.
   */
  schemaFields(): EscalationSchemaFields {
    return {
      sandbox_permissions: {
        type: 'string',
        enum: [...this.escalationModes],
        description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry '
          + 'of an operation the sandbox just denied; requires justification and user approval.',
      },
      justification: {
        type: 'string',
        description: 'Required with sandbox_permissions: one sentence for the user explaining '
          + 'why this exact file operation needs the wider access.',
      },
    }
  }

  /**
   * The policy to stamp onto this mutation: an approved escalation grant (a
   * strictly wider retry resolved through `ctx.approval` before anything
   * executes), else the session's standing mode. The calling session's cwd is
   * always carried as the workspace root. A session that cannot escalate gets
   * a direct no-argument retry instruction before escalation-pair validation.
   * @param toolName - the mutating tool's name, for the approval audit trail.
   * @param args - the call's escalation arguments.
   * @param exec - the tool-execution context (agent, callId, signal).
   * @returns the policy to pass to the mutation, or undefined for an
   *   unsandboxed backend.
   */
  async resolvePolicy(toolName: string, args: FsEscalationArgs, exec: ToolExecution): Promise<SandboxExecutionPolicy | undefined> {
    const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} })
    if (args.sandbox_permissions !== undefined) {
      const approval: ApprovalService | undefined = this.ctx.get('approval')
      if (exec.agent !== undefined && approval?.effectivePolicy(exec.agent.session) === 'never') {
        throw new Error(
          'sandbox escalation is disabled by this session approval policy; '
          + 'retry without sandbox_permissions and justification',
        )
      }
      if (standingPolicy?.mode === 'danger-full-access') {
        throw new Error(
          'sandbox escalation is unavailable because this call already has danger-full-access; '
          + 'retry without sandbox_permissions and justification',
        )
      }
    }
    validateEscalationArgs(args.sandbox_permissions, args.justification)
    if (args.sandbox_permissions === undefined || args.justification === undefined) {
      return standingPolicy
    }
    if (this.escalationModes.length === 0) {
      throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
    }
    const policy = standingPolicy as SandboxExecutionPolicy
    const approvedMode = await approveEscalation(
      { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: policy.mode, subject: 'operation' },
      {
        approver: this.ctx.get('approval'),
        agent: exec.agent,
        callId: exec.callId,
        toolName,
        signal: exec.signal,
      },
    )
    return { ...policy, mode: approvedMode }
  }

  /**
   * Map a thrown provider error for the model: a `FS_SANDBOX_DENIED` becomes a
   * `FsError` whose text is the shared `[sandbox: …]` denial marker plus the
   * same-turn escalation hint when this session can ask, so a policy denial
   * reads identically to bash's while keeping the structured
   * `FS_SANDBOX_DENIED` code. `ToolRuntime`
   * populates `result.error` only for `HarnessError` instances, so a plain
   * `Error` would strip the code retry/observers key off. Any other error
   * passes through unchanged. A `FS_SANDBOX_DENIED` only arises under a
   * confining backend; the marker always applies, while the hint follows the
   * current session policy.
   * @param error - the error thrown by the mutation.
   * @param policy - the policy stamped onto the call (names the mode in the marker).
   * @param exec - the calling execution whose approval policy controls the hint.
   * @returns the error to throw — the marker `FsError` for a sandbox denial, else the original.
   */
  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined, exec: ToolExecution): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    // A FS_SANDBOX_DENIED only arises under a confining backend, whose tool
    // path always resolves a policy before mutation.
    const mode = (policy as SandboxExecutionPolicy).mode
    const hint = this.canEscalate(exec.agent, policy) ? `\n${escalationHintMarker('operation')}` : ''
    return new FsError(`${sandboxDenialMarker(mode)}${hint}`, 'FS_SANDBOX_DENIED', { cause: error })
  }
}
