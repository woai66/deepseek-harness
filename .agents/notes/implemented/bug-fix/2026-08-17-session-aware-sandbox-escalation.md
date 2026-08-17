# Agent Note: Session-aware sandbox escalation visibility

Status: implemented

English | [中文](2026-08-17-session-aware-sandbox-escalation.zh.md)

## Problem

A confining filesystem or shell provider proves that the composition can enforce a wider one-shot sandbox mode. It does not prove that the current session can request that mode. Sessions with effective approval policy `never` cannot obtain approval, and sessions already at `danger-full-access` have no wider mode. The tools nevertheless exposed `sandbox_permissions`, `justification`, and escalation retry guidance whenever the provider confined.

This mixed message was especially harmful under `danger-full-access` plus `never`: the model saw escalation controls and followed their guidance, while the approval policy rejected every request. Error-only enforcement left the impossible controls visible on the next request, so a model could repeat the same call. The runtime policy context did not resolve the contradiction because it described standing policy while the tool schema still advertised an unavailable action.

## Decision

Sandbox escalation is model-visible only when one session can use it. During every `system-prompt/assemble`, the bash, pwsh, and filesystem tool Consumers retain the escalation fields and guidance only when a confining provider is mounted, the resolved standing mode is below `danger-full-access`, and `ApprovalService.effectivePolicy(session)` is `ask`. `withoutEscalationSchema()` removes both fields from the detached assembled schema; it does not mutate the registered tool definition. `ApprovalService.effectivePolicy(session)` is public so read paths can use the same durable fold as approval enforcement.

Denial results use the same session facts. Filesystem errors append the escalation marker only when the denied call can ask. Foreground shell results carry the call-time `escalationAvailable` fact in their canonical sandbox projection so pure renderers do not re-read mutable policy; background renderers capture the same fact for the call. A denial under `never`, at `danger-full-access`, or without an approval service contains no escalation retry hint.

Execution remains the authority when a caller injects fields that were absent from the schema. A request under `never` fails before argument-pair validation or execution with `sandbox escalation is disabled by this session approval policy; retry without sandbox_permissions and justification`. A request already at `danger-full-access` likewise fails with `sandbox escalation is unavailable because this call already has danger-full-access; retry without sandbox_permissions and justification`. The ordering prevents an empty justification from replacing the actionable session-policy diagnostic. Other malformed or unavailable escalation requests retain their existing fail-closed outcomes.

This refines the escalation advertisement in the [sandbox decision](../feature/2026-07-06-sandbox.md) and its [cross-family filesystem extension](../feature/2026-07-14-cross-family-fs-sandbox.md). It uses the authoritative per-request policy resolution established by the [current sandbox policy context decision](../feature/2026-07-30-current-sandbox-policy-context.md). Those notes retain independent enforcement, provider, and durable-policy rationale and remain active.

## Alternatives considered

**Rely on the runtime approval-policy sentence.** Rejected because a prose statement that approvals are disabled does not neutralize schema fields and descriptions that instruct the model to request approval.

**Keep static schemas and improve only the execution error.** Rejected because the next request would advertise the same impossible action again. The error is still required as a defense for injected or stale calls, but it cannot be the primary model interface.

**Hide fields but keep denial retry guidance.** Rejected because a result would direct the model toward arguments the next schema does not accept. Schemas, descriptions, denial markers, and execution checks must derive from the same session facts.

**Re-register tools when permission changes.** Rejected because the assembly waterfall already produces detached schemas for one request. Mutating the shared registry would couple sessions and create races between concurrent agents.

## Consequences

Models no longer see or receive guidance for sandbox escalation that cannot succeed in the current session. Forced requests still fail before execution with a correction that ends the retry loop. The escalation target enum remains complete whenever escalation is available, and execution still enforces strict widening and one-call approval.

Permission switches may add or remove fields in the next request header, so reuse from the first changed tool definition may miss the KV cache. That cost is accepted because preserving a static prefix would expose a false capability. The assembled request header is logged, so replay reconstructs the exact model-visible schema.

Focused unit tests pin schema removal, retained `ask` behavior, hint suppression, guard ordering, no approval request, and no execution for injected fields across bash, pwsh, and filesystem tools. A keyless headless snapshot boots the shipped Loader composition under `danger-full-access` and verifies that the persisted bash or pwsh, write, and edit schemas omit both escalation fields and their guidance.
