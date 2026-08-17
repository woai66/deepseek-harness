# Agent Note: 会话感知的 sandbox 升级可见性

Status: implemented

[English](2026-08-17-session-aware-sandbox-escalation.md) | 中文

## Problem

约束型文件系统或 shell provider 能证明该组合可以执行一次性的更宽 sandbox 模式，但不能证明当前会话可以请求该模式。有效审批策略为 `never` 的会话无法获得批准，而已经处于 `danger-full-access` 的会话没有更宽模式。工具此前只要 provider 提供约束，就会公开 `sandbox_permissions`、`justification` 和升级重试指引。

这种矛盾在 `danger-full-access` 加 `never` 下尤其有害：模型看到升级控件并遵循其指引，而审批策略拒绝每个请求。只在执行期报错会让下一次请求继续显示不可能成功的控件，因此模型可能重复同一调用。运行时策略上下文也不能消除矛盾，因为它描述的是常驻策略，而工具 schema 仍在宣告不可用操作。

## Decision

只有一个会话确实可用时，才向模型显示 sandbox 升级。在每次 `system-prompt/assemble` 期间，bash、pwsh 和文件系统工具 Consumer 仅在已挂载约束型 provider、解析后的常驻模式低于 `danger-full-access`，且 `ApprovalService.effectivePolicy(session)` 为 `ask` 时保留升级字段与指引。`withoutEscalationSchema()` 从本次组装得到的独立 schema 中移除两个字段，不修改已注册的工具定义。`ApprovalService.effectivePolicy(session)` 公开后，读取路径与审批强制执行使用同一份持久 fold。

拒绝结果使用相同的会话事实。文件系统错误只在被拒调用可以请求审批时追加升级 marker。前台 shell 结果在规范 sandbox 投影中携带调用时的 `escalationAvailable` 事实，使纯渲染器无需重读可变策略；后台渲染器为该调用捕获同一事实。处于 `never`、已经是 `danger-full-access` 或没有审批服务时，拒绝结果不包含升级重试提示。

当调用方注入 schema 中已省略的字段时，执行入口仍是权威。`never` 下的请求会在参数配对校验或执行之前失败，错误为 `sandbox escalation is disabled by this session approval policy; retry without sandbox_permissions and justification`。已经处于 `danger-full-access` 的请求同样失败，错误为 `sandbox escalation is unavailable because this call already has danger-full-access; retry without sandbox_permissions and justification`。这一顺序防止空 justification 覆盖可操作的会话策略诊断。其他格式错误或不可用的升级请求保留既有 fail-closed 结果。

本决策细化了 [sandbox 决策](../feature/2026-07-06-sandbox.md)及其[跨文件系统家族扩展](../feature/2026-07-14-cross-family-fs-sandbox.md)中的升级宣告，并使用[当前 sandbox 策略上下文决策](../feature/2026-07-30-current-sandbox-policy-context.md)建立的权威按请求策略解析。这些既有记录仍分别拥有强制执行、provider 与持久策略理由，因此保持活跃。

## Alternatives considered

**只依赖运行时审批策略句子。** 否决，因为说明审批已禁用的 prose 无法抵消指导模型请求审批的 schema 字段与描述。

**保留静态 schema，只改进执行错误。** 否决，因为下一次请求会再次宣告同一个不可能成功的操作。错误仍然是防御注入调用或陈旧调用所必需的，但不能成为主要模型接口。

**隐藏字段，但保留拒绝结果中的重试指引。** 否决，因为结果会指导模型使用下一份 schema 不接受的参数。schema、描述、拒绝 marker 与执行检查必须派生自相同的会话事实。

**在权限变化时重新注册工具。** 否决，因为 assembly waterfall 已经为一次请求生成独立 schema。修改共享注册表会耦合多个会话，并在并发 agent 之间产生竞态。

## Consequences

模型不再看到当前会话中无法成功的 sandbox 升级，也不会收到相关指引。强制请求仍在执行前失败，并给出终止重试循环的修正方式。升级可用时，目标枚举仍保持完整；执行期仍强制严格拓宽和单次调用审批。

权限切换可能在下一次请求 header 中增加或移除字段，因此从首个变化的工具定义开始可能无法复用 KV cache。这里接受该成本，因为保留静态前缀会暴露虚假能力。组装后的请求 header 会被记录，因此回放可以重建模型实际看到的 schema。

针对性单元测试固定了 bash、pwsh 和文件系统工具的 schema 移除、保留 `ask` 行为、提示抑制、守卫顺序、不发起审批，以及注入字段时不执行。无密钥 headless 快照会在 `danger-full-access` 下启动发行版 Loader 组合，并验证持久化的 bash 或 pwsh、write 与 edit schema 省略两个升级字段及其指引。
