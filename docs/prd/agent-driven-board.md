# Agent Team × 看板架构重设计 PRD

> 版本：v0.2 (草稿)
> 范围：packages/contracts, packages/server, packages/web
> 目标读者：kilerd

---

## 核心原则（读文档前先记住这三句）

1. **代码是 Tool Server，不是 Workflow Engine**。我们给 agent 暴露一组原子 API；流程由 agent 的 skill / prompt 决定。
2. **Coordinator 是长期活着的 AgentSession**，不是一次性 LLM 调用。用户消息和系统事件都是 session 内的 turn（resume + append）。
3. **Agent 的职责描述分两层**：`AccountAgent.description` 是跨 workspace 的"能力画像"（固有特长），`WorkspaceAgent.description` 是"在本 workspace 的具体职责"（可覆盖/补充 account 级）。Coordinator 运行时同时看这两层，自行判断把 planning / review / coding 委派给谁。代码不枚举 role 分支。

---

## 0. Context

### 0.1 为什么做

目前 workhorse 同时背着两套多 agent 协作模型：
- **Legacy `AgentTeam`**：team 内嵌 `TeamAgent[]`，team-scoped。对应表：`teams`, `team_messages`。
- **Phase 4 `WorkspaceAgent`**：account-level agent 挂载到 workspace，role 驱动。对应表：`agents`, `workspace_agents`, `workspace_channels`, `channel_messages`, `task_messages`。

两套模型并行，导致：
- **30~40% 的协调逻辑在 `BoardService` 中重复**（`approveProposal` vs `approveProposalByWorkspace`、`buildCoordinatorStartOptions` vs `buildCoordinatorStartOptionsWs` 等）。
- **三张消息表结构类似但彼此分离**，前端 `coordination.ts` 需要运行时用 `CoordinationScope` 分支。
- **看板的概念断层**：
  - Coordinator 本身是一个 Task（`column` 会在 backlog / running / review 之间流转），但它的语义是「在 plan」，不是「在执行」。
  - `#coordinator` channel 背后藏着一个 hidden `channel_backing` task，这是漏抽象。
  - Coordinator 产出 `CoordinatorProposal` 是 Plan 的草稿，却被 Task 状态机强行套用。
- **`BoardService` 4171 行**，一个服务同时背着：Team CRUD、Task 生命周期、Proposal 审批、消息发布、Scheduler 调用、PR 创建、Channel backing。耦合严重。

### 0.2 用户诉求

> 在 agent team 模式下驱动看板。

即：**Agent Team 是任务的生产者和执行引擎；看板是任务及其状态的唯一视图**。两者应通过一个清晰的 Task Lifecycle 模型衔接，而不是像现在这样交叠、互相侵蚀概念。

### 0.3 现状：AgentTeam vs WorkspaceAgent 职责对比

这是当前代码里两套并行模型各自管什么——不是新设计，是现状事实清单：

| 维度 | Legacy `AgentTeam`（Phase 1–3） | Phase 4 `WorkspaceAgent` |
|---|---|---|
| **Agent 定义位置** | 内嵌在 `teams.agents` JSON 列里，`TeamAgent` 绑死某个 team | `agents` 表（account 级定义）+ `workspace_agents` 表（挂载到某个 workspace，带 role） |
| **Agent 复用** | 不可跨 team 复用，一个 agent 配置要改得改所有 team | 一次定义，多 workspace 挂载；role 在挂载点决定 |
| **组织单元** | `AgentTeam`（workspace 下的一个子团队） | `Workspace` 直接管；没有中间的 team 层 |
| **对话入口** | 没有专门入口；用户通过**创建一个 parent Task + 填 description** 来触发 coordinator | `#coordinator` channel（或 task channel），用户发消息 = 对话 |
| **消息表** | `team_messages`（按 `teamId + parentTaskId` 组织） | `channel_messages`（thread 内）+ `task_messages`（task 内，细节评论） |
| **Coordinator 执行** | 是一个真实 Task，`column` 会在 backlog/running/review 间流转 | 是一个**隐藏** Task（`taskKind="channel_backing"`），不显示在看板，只为 run 生命周期借壳 |
| **触发方式** | 用户手点 Start → coordinator task 起 run | 用户发 channel message → 后端启动 backing task 的 run |
| **Proposal 归属** | `coordinator_proposals.team_id`（必填） | `coordinator_proposals.workspace_id + channel_id`（team_id 留空） |
| **子任务产出** | `createCoordinatorSubtasks`（`board-service.ts:2949`） | `createCoordinatorSubtasksWs`（同文件的姊妹方法） |
| **子任务字段** | `task.teamId + teamAgentId` | `task.workspaceAgentId`（不挂 team） |
| **PR 策略配置** | `team.prStrategy + autoApproveSubtasks` | `workspace.prStrategy + autoApproveSubtasks` |
| **前端入口组件** | `TeamsPage` + `TeamCard` + `TeamMessageFeed` | `WorkspaceChannelPage` + channel 列表 |
| **审批面板** | `CoordinatorProposalPanel`（teamId 路由） | `CoordinatorProposalPanel`（workspace + channel 路由，同组件分支处理） |

**两者在代码里的"重复点"**：
- `BoardService` 里每个协调方法几乎都有 legacy 版 + `...Ws` 版两份（approveProposal / buildCoordinatorStartOptions / createCoordinatorSubtasks）。
- `CoordinatorProposal` 一个实体同时要兼容两种归属，字段半可选。
- 前端 `lib/coordination.ts` 用 `CoordinationScope = "legacy_team" | "workspace"` 做运行时分支。

**结论**：
- Legacy `AgentTeam` = "先有 team，再有 agent，再有对话（通过 task 借壳）"
- Phase 4 `WorkspaceAgent` = "先有 workspace 和 agent，对话在 thread 里，task 是对话的产出"
- **Phase 4 的心智模型更自然**，且已经覆盖了 Legacy 的所有能力（甚至更多：agent 跨 workspace 复用、channel 作对话入口）。Legacy 保留主要是历史惯性。

### 0.3 非目标（本轮不做）

- 重写 Runner 层（claude-cli / codex-acp / shell 保留）。
- 重写 WebSocket 事件总线（事件 payload 会调整但机制不变）。
- 改 SQLite 存储引擎。
- UI 的视觉大改（只改必要的结构，视觉复用 shadcn 基线）。

---

## 1. 核心抽象（Target Model）

### 1.1 一句话心智模型

```
Account ── AccountAgent (name, description, runnerConfig)
                  │   └─ description = 跨 workspace 的能力画像（"擅长前端架构"）
                  │
                  ▼  挂载
Workspace ─┬─ WorkspaceAgent (accountAgentId, description?)
           │     └─ description = 在本 workspace 的具体职责（"负责 planning"）
           │        可覆盖/补充 account 级
           │
           ├─ Thread (#coordinator | task | direct)
           │     ├─ Message (chat | status | artifact | plan_draft | plan_decision)
           │     └─ AgentSession（长期持有，resume 式对话）
           │
           └─ Task ─── Run ─── LogEntry
                 └─ 看板卡；生命周期由 coordinator 的 session 决策驱动
```

**三条铁律**：
1. **所有对话都在 Thread 里**（team / channel / task 评论三合一）。
2. **所有工作单元都是 Task**（user-created / agent-planned 以 `source` 字段区分，不再有隐藏 task）。
3. **Coordinator 是长期活着的 AgentSession，不是一次性 prompt 调用**。Thread 生命周期内 session 持续存在，新消息 = 新 turn（append + resume），系统事件（task 状态变化）作为 message 注入 session。

### 1.2 统一后的实体

| 实体 | 替代 | 关键字段 |
|---|---|---|
| `AccountAgent` | 保留；`TeamAgent` 合入；**废弃 `AgentTeam`** | `id, name, description, runnerConfig` — description 是**跨 workspace 的能力画像**（例：「擅长前端架构，熟 React/TypeScript」） |
| `WorkspaceAgent` | 保留 + 扩字段 | `id, workspaceId, accountAgentId, description?` — 可选的**本 workspace 具体职责**（例：「在本仓库负责做 planning，拆分顶层需求」）。Coordinator 同时看 account + workspace 两层 description |
| `Thread` | `WorkspaceChannel` 改名 | `id, workspaceId, kind: "coordinator" \| "task" \| "direct", taskId?, coordinatorAgentId, coordinatorState: "idle" \| "queued" \| "running"` |
| `Message` | `TeamMessage` + `ChannelMessage` + `TaskMessage` 合并 | `id, threadId, sender, kind: "chat" \| "status" \| "artifact" \| "plan_draft" \| "plan_decision" \| "system_event", payload, consumedByRunId?` |
| `Plan` | `CoordinatorProposal` 重命名 | `id, threadId, proposerAgentId, status: "pending" \| "approved" \| "rejected" \| "superseded", drafts[], approvedAt?` |
| `Task` | 保留 | 新增 `source: "user" \| "agent_plan", planId?, parentTaskId?, assigneeAgentId`；删除 `teamId / teamAgentId` |
| `Run` | 保留 + 扩展 | 新增 `threadId?, agentSessionId` —— 现在 Run 既可绑定 task（worker run）也可绑定 thread（coordinator session 的一次 turn）|
| `AgentSession`（新） | — | `id, workspaceId, agentId, threadId, runnerSessionKey`（claude `--resume` id / codex session id 等），整个 thread 期只有一份 |

### 1.3 关键语义澄清

#### Agent 是"能力声明者"，不是"角色枚举"
- 不再硬编码 `role: coordinator | worker`。
- `AccountAgent.description`：**能力画像**，跨 workspace 不变。例："擅长前端架构，熟 React/TypeScript"。
- `WorkspaceAgent.description`：**在本 workspace 的具体职责**，可选。例：同一个前端 agent 在 workspace A 是"写前端代码"，在 workspace B 被配置为"做前端 code review"。
- Coordinator 拼 prompt 时会把 workspace 下所有 WorkspaceAgent 的**两层 description 合并呈现**（account 层描能力，workspace 层描职责），让 coordinator 理解"这个 agent 能做什么 + 在这里应该做什么"。
- **Thread 级别有一个"主 coordinator"绑定**（`Thread.coordinatorAgentId` 指向一个 WorkspaceAgent）；其他 agent 能不能被召唤由主 coordinator 在 run 里自己判断。

#### Coordinator 是一种 thread-bound session，不是一次调用
- Workspace 创建 `#coordinator` thread 时，指定一个 agent 作为主 coordinator，并开启 AgentSession。
- 用户发消息 / 系统事件（plan approved、task finished、user rejected）都是这个 session 里的新 turn。
- Runner 层提供 `resumeOrStart(sessionKey, newMessages[]) → Run`，内部对接各 runner 的 session 能力（Claude `--resume`、Codex session continuity）。
- Prompt 不再"每次重建完整上下文"，只 append 新消息。Token 成本大幅下降，coordinator 连续记忆。

#### Coordinator 通过"指令"驱动系统（非固定 JSON 输出）
Coordinator 的 run 输出不再限定为"subtasks JSON"，而是一组可结构化指令（通过约定的 tool call / 标签语法）：

| 指令 | 效果 |
|---|---|
| `reply(text)` | 向 thread 追加一条 `kind=chat` message |
| `plan(drafts[])` | 创建 `Plan(pending)` + thread 里追加 `plan_draft` message，等待用户审批 |
| `delegate_planning(agentId, brief)` | 召唤另一个 agent（通常是 description 里声明自己做 planning 的那个）去生成 plan；其输出回 feed 给 coordinator |
| `start_task(taskId)` | 启动某个已存在的 task run（**替代 TaskScheduler 的调度决策**） |
| `spawn_review(taskId, agentId?)` | 召唤一个 agent（通常是 description 里声明自己做 review 的）对某个已完成 task 做审查 |
| `request_user_input(question)` | 明确卡到用户确认 |

这组指令不是代码硬约束，而是**写在 coordinator prompt 里的"能力说明"**。代码层只是把 coordinator 的输出解析成 orchestrator 可执行的 op。

#### TaskScheduler 降级为"执行引擎"
- 现有 TaskScheduler 的**决策逻辑**（何时启动哪个 task、依赖满足度判断、并发控制）**由 coordinator 在 session 里自行完成**。
- 代码层只保留"执行排队"：coordinator 同时发 5 个 `start_task` 时，按 runner 可用性排队启动；不做"看 dependencies 哪个 ready"这类判断。
- `Task.dependencies` 字段保留为"coordinator 参考提示"（作为上下文 feed 给 coordinator），不是代码硬约束。

#### Review、PR、审批策略由 coordinator prompt 驱动
- 当前硬编码的 `workspace.prStrategy` / `autoApproveSubtasks` 不再写在代码分支里。
- 改为：这些 setting 以文本形式塞进 coordinator 的 system prompt。coordinator 自行决定：
  - 是否要 `spawn_review` 召唤 reviewer agent。
  - subtask 完成后要不要直接开 PR（`open_pr` 指令）。
  - 是否继续启动下一个 task 还是等用户确认。
- 代码层只提供执行工具（`PrService.createPullRequest`、`ReviewService.run` 等），不决策"什么时候用"。

#### `#coordinator` thread 不再背靠隐藏 task
- `#coordinator` 是 `kind="coordinator"` 的 Thread，直接绑一个 AgentSession。
- 不再有 `channel_backing` 的 hidden Task。coordinator run 属于 `Run.threadId = thread.id`，不属于任何 task。

---

## 2. 架构图

### 2.1 运行时组件（反转：agent 驱动代码）

```
                         ┌──────────────────────────────────┐
                         │            packages/web          │
                         │   ┌──────────┐    ┌───────────┐  │
                         │   │  Board   │◀──▶│  Thread   │  │
                         │   │  (Task)  │    │   View    │  │
                         │   └──────────┘    └───────────┘  │
                         └───────────┬──────────────────────┘
                                     │ REST + WS (ServerEvent)
        ┌────────────────────────────┴──────────────────────────┐
        │                   packages/server                     │
        │                                                       │
        │   ┌────────────┐   ┌─────────────┐   ┌────────────┐   │
        │   │TaskService │   │ThreadService│   │PlanService │   │
        │   │(CRUD、列、 │   │(消息、      │   │(提案审批、 │   │
        │   │ 审批)      │   │ session 映射)│  │ CAS 事务)  │   │
        │   └──────┬─────┘   └──────┬──────┘   └─────┬──────┘   │
        │          │                │                │          │
        │          ▼                ▼                ▼          │
        │    ┌─────────────────────────────────────────────┐    │
        │    │           Orchestrator                      │    │
        │    │   职责：                                    │    │
        │    │   ① thread ↔ AgentSession 绑定与 resume     │    │
        │    │   ② per-thread coordinator 串行队列 +       │    │
        │    │     批量 flush                              │    │
        │    │   ③ 解析 coordinator 输出指令：             │    │
        │    │      plan / start_task / spawn_review /     │    │
        │    │      delegate_planning / reply / ...        │    │
        │    │   ④ 把系统事件（plan approved、task done、  │    │
        │    │     user reject）回注成 system_event msg    │    │
        │    │     到 coordinator session                  │    │
        │    │   ⑤ 执行层：启动 task run / 调用 PrService  │    │
        │    └────────────────────┬────────────────────────┘    │
        │                         │                              │
        │                         ▼                              │
        │   ┌─────────────────────────────────────────────┐     │
        │   │       Runner Adapters (session-aware)       │     │
        │   │   resumeOrStart(sessionKey, msgs[]) → Run   │     │
        │   │   ├─ claude-cli: --resume + stdin append    │     │
        │   │   ├─ codex-acp : session handle + user turn │     │
        │   │   └─ shell     : 无 session，退化全量       │     │
        │   └──────────────────┬──────────────────────────┘     │
        │                      ▼                                 │
        │               ┌────────────────┐                       │
        │               │ StateStore     │                       │
        │               │ (SQLite)       │                       │
        │               └────────────────┘                       │
        └───────────────────────────────────────────────────────┘
```

**与旧设计差异**：
- **没有独立的 TaskScheduler**：调度决策上移到 coordinator，代码层只做"执行排队"。
- **Runner 加 session 语义**：`resumeOrStart` 替代每次新 run。
- **Orchestrator 是"指令翻译器 + 事件回注器"**：把 agent 输出的 `start_task(id)` 翻译成 `TaskService.startRun(id)`，把 task 状态变化包成 `system_event` message 回注 coordinator session。
- **工程代码只提供工具（tools），不做流程决策**：PR 何时开、review 何时跑、任务何时推进——都由 coordinator 在 prompt 的能力说明下自行决定。

### 2.2 数据关系

```
Workspace 1─┬─* Agent (description)
            │
            ├─* Thread ─── 1 AgentSession ─── * Run (coordinator turns)
            │   │            (sessionKey)
            │   └── * Message
            │         ├─ kind=chat
            │         ├─ kind=plan_draft       ──▶ Plan (1:1)
            │         ├─ kind=plan_decision
            │         ├─ kind=status
            │         ├─ kind=artifact
            │         └─ kind=system_event     ◀── task done / plan approved / ...
            │
            └─* Task ─── * Run (worker) ─── * LogEntry
                 │
                 ├─ column (backlog/todo/blocked/running/review/done/archived)
                 ├─ source (user | agent_plan)
                 ├─ planId?
                 ├─ parentTaskId?
                 ├─ assigneeAgentId
                 └─ threadId  (每个 task 自带一个 kind=task thread)
```

### 2.3 三种 Run 的统一

| Run 类型 | 关联实体 | 触发 | 终止后动作 |
|---|---|---|---|
| Coordinator turn | `Run.threadId`, `agentSessionId` | 用户/事件触发 | 解析输出指令，执行 op；检查 queue，决定是否再触发一轮 |
| Worker task | `Run.taskId` | coordinator 发 `start_task` | task.column=review，artifact 写 task thread，system_event 回注 coordinator session |
| Ad-hoc agent（reviewer / planner） | `Run.threadId`（临时 thread 或主 thread） | coordinator 发 `spawn_review` / `delegate_planning` | 输出回 feed 给召唤方 |

---

## 3. 流转图

### 3.1 核心原则：代码是 Tool Server，Agent 是 Workflow Engine

> **我们不是在写一个 workflow 引擎，我们是在给 agent 暴露一组操作看板的 API。**

- 代码层职责：**暴露一组稳定、原子、副作用明确的 API（tools）**；维护数据一致性；发布事件。
- Agent 层职责（通过 Claude Code skill / prompt / tool use）：**决定何时调用哪个 API，组合成业务流程**。

工程代码里**不该**出现的规则（应全部搬到 agent skill / prompt 里）：
- ❌ "subtask 完成后自动转到 review 列"
- ❌ "dependencies 都满足才启动"
- ❌ "autoApproveSubtasks=true 则自动 approve"
- ❌ "prStrategy=independent 则为每个 subtask 开独立 PR"
- ❌ "每次 user 发言就跑一次 coordinator"
- ❌ "task 失败了重试 3 次"

工程代码**只**保留的约束（不可由 agent 绕过）：
- ✅ 数据一致性（事务、CAS、外键、不变量）
- ✅ 资源限制（同时最多 N 个 runner、API rate limit）
- ✅ 安全边界（agent 不能直接写 SQL，只能调 API）
- ✅ 串行化（同 thread 的 coordinator run 串行，不允许并发 hit session）

### 3.2 API / Tool 清单（代码暴露给 agent 的接口）

Agent 通过 Claude Code / Codex 的 tool use 机制调用。每个 tool 是一个**幂等、明确副作用**的 API：

**Task 操作**
| Tool | 作用 | 典型调用者 |
|---|---|---|
| `create_task(title, description, assigneeAgentId?, dependsOn?[])` | 在看板 backlog 列创建一个 task | planner agent / coordinator |
| `move_task(taskId, column)` | 改 column（受约束：running/review 仍由系统维护） | coordinator |
| `start_task_run(taskId, prompt?, runnerOverride?)` | 启动该 task 的一次 worker run | coordinator |
| `cancel_task_run(taskId)` | 取消正在运行的 worker | coordinator |
| `annotate_task(taskId, note)` | 给 task thread 追加 chat message | any agent |
| `decide_task(taskId, "approve"|"reject", reason?)` | 把 review 列 task 决策为 done | coordinator / reviewer |

**Plan 操作**
| Tool | 作用 | 典型调用者 |
|---|---|---|
| `propose_plan(drafts[])` | 创建 Plan(pending) 并推到 thread 等用户审批 | coordinator / planner |
| `supersede_plan(planId, reason)` | 作废一个 plan | coordinator |

**Thread / Message 操作**
| Tool | 作用 | 典型调用者 |
|---|---|---|
| `post_message(threadId, text)` | 发一条 chat | any agent |
| `request_user_input(question, options?)` | 显式卡住等用户回复 | coordinator |

**Agent 召唤**
| Tool | 作用 | 典型调用者 |
|---|---|---|
| `list_agents()` | 列出 workspace 下所有 agent，返回 `{workspaceAgentId, name, accountDescription, workspaceDescription?}`，两层 description 都暴露给调用者 | coordinator |
| `spawn_agent(agentId, brief, threadId?)` | 启动一个临时 agent run，输出回 feed 给召唤方 | coordinator |

**PR / Git 操作**
| Tool | 作用 | 典型调用者 |
|---|---|---|
| `open_pr(taskId, title, body, base?)` | 从 task worktree 开 PR | worker / coordinator |
| `get_diff(taskId)` | 读 worktree 当前 diff | any agent |

**只读查询**
| Tool | 作用 |
|---|---|
| `get_workspace_state()` | 返回 workspace 当前所有 task、plan、thread 快照 |
| `get_task(taskId)` | 单个 task 详情 |

### 3.3 End-to-End 示例（用户侧 → agent skill → API）

```
[用户] 在 #coordinator 发 "实现 FAQ 章节"
   │
   ▼
[ThreadService] persist + publish
   │
   ▼
[Orchestrator] idle → resumeOrStart coordinator session，把用户消息 append 进去
   │
   ▼
[Coordinator session 的 skill 执行]
   业务逻辑完全在 agent skill 里：
   
   skill: "handle-user-request"
   steps (由 agent 自己组织)：
     1. 调 list_agents() → 看谁声称自己 plan
     2. 若有 planner agent：spawn_agent(planner, brief="拆分 FAQ 实现")
        若无：自己分解
     3. 拿到 drafts → propose_plan(drafts)（用户看到后审批）
     4. 停住等 system_event "plan X approved"
   │
   ▼
[用户 approve plan]
   │
   ▼
[PlanService.approve] → inject system_event 到 coordinator session
   │
   ▼
[Coordinator session 继续]
   skill: "orchestrate-tasks"
   steps：
     5. 看 get_workspace_state()，找 todo 列里 planId 匹配的 task
     6. 按自己判断的顺序依次 start_task_run(id)
     7. 等 system_event "task X finished"
     8. 对每个完成的 task：
        - 读 workspace setting（prompt 里有）
        - 若需要 review：spawn_agent(reviewer, ...) 或直接 open_pr
        - 决定 decide_task("approve") 或等用户
     9. 全部 done → post_message(#coordinator, "完成总结...")
```

**关键点**：
- 以上 9 步全部是 **agent skill 的业务逻辑**，不是代码 if/else。
- 换一个有不同工作习惯的 coordinator agent（不同 prompt / skill），整个工作流可以完全不同，**代码零改动**。
- 若未来新增一类 workflow（比如"并行 + vote"模式），也只是改 agent skill，不改代码。

### 3.2 状态机：Task.column 与 Run.status 的关系（简化）

```
         ┌─────────────┐
         │   backlog   │◀── 用户手动创建 or plan approve 前的暂存
         └─────┬───────┘
               │ user drag / plan approve
               ▼
         ┌─────────────┐
  ┌─────▶│    todo     │
  │      └─────┬───────┘
  │            │ scheduler picks (deps ok)
  │            ▼
  │      ┌─────────────┐     ┌─────────────┐
  │      │   blocked   │◀────│  deps miss  │
  │      └─────────────┘     └─────────────┘
  │            │ deps satisfied
  │            ▼
  │      ┌─────────────┐
  │      │   running   │  (Run.status = running)
  │      └─────┬───────┘
  │            │ Run.status ∈ {succeeded, failed, interrupted}
  │            ▼
  │      ┌─────────────┐
  │      │   review    │
  │      └──┬───────┬──┘
  │         │       │
  │  reject │       │ approve
  │         ▼       ▼
  │   ┌──────────────────┐
  └── │       done       │──▶ archived (手动)
      └──────────────────┘
```

**关键约束**：
- `column=running` ⇔ 存在 `Run.status ∈ {queued, running}` 的 Run。这是不变量，由 `Orchestrator` 维护，禁止前端直接拖到 `running`。
- `column=review` 只能由 `Orchestrator.onRunFinished` 或用户 reject 进入；用户拖拽受限。
- Plan 内的 subtask 必须 `source="agent_plan"`，不可脱离 Plan 单独存在（删 Plan → 所有未 done 的 subtask 也被取消）。

### 3.3 用户直接创建 Task（不经过 coordinator）

保留此路径。`source="user"`，`planId=null`。看板上样式略做区分（例如一个小 badge），但生命周期与 agent_plan task 相同。

---

## 4. 关键决策点（已确认）

| # | 决策 | 结论 | 备注 |
|---|---|---|---|
| D1 | AgentTeam vs WorkspaceAgent | **彻底合并到 WorkspaceAgent** | Legacy `AgentTeam` 废弃；`teams` 表保留为只读归档，UI 删除；migration 把每个 team 的 agents 拆到 `workspace_agents` |
| D2 | 消息表是否合并 | **合并为单一 `messages` 表** | `team_messages` + `channel_messages` + `task_messages` 三合一；加 `thread_id` + `kind` 字段区分 |
| D3 | Plan 如何呈现 | **作为 Thread 内一条可审批 message** | `plan_draft` + `plan_decision` 都是 `Message.kind`，UI 在 Thread 内联审批；废弃独立 `CoordinatorProposalPanel` |
| D4 | 用户是否还能手动创建 Task | **保留** | `source="user"` 的 task 与 agent_plan task 生命周期一致，看板上用 badge 区分 |
| D5 | Coordinator 触发策略 | **串行 + 批量合并** | 详见 §4.5；per-thread 串行，run 期间用户消息入队，run 结束后 batch flush |
| D6 | 本轮是否拆分 BoardService | **一次性拆成四个服务** | TaskService / ThreadService / PlanService / Orchestrator |

---

## 4.5 Coordinator 触发策略（D5 确认方案）

### 4.5.1 模型：Per-Thread 串行 + 批量合并

每个 Thread（workspace `#coordinator` / task thread）维护一个 **coordinator run queue**，语义：

- 同一 thread 内同时最多只有一个 coordinator run 在执行（`in_flight`）。
- Run 执行期间，用户继续发消息 → 消息正常写库 + 广播，但**不立刻触发新的 coordinator run**，只是在 thread 上标记这些消息为 "pending for next coordinator turn"。
- 当前 run 结束（`succeeded` / `failed` / `canceled`）→ Orchestrator 检查该 thread 的 pending 消息队列：
  - 队列为空：静默结束。
  - 队列非空：把**所有 pending 消息按时间顺序拼成一个 batch**，一次性构造下一轮 prompt，启动新的 coordinator run。
- 新 run 开始时，这批消息从 "pending" 翻转为 "consumed by run N+1"，在 UI 上可以视觉上归簇（例如一条竖线或小灰条）。

### 4.5.2 状态机

```
Thread.coordinatorState:
                      ┌──────────┐  user msg arrives  ┌────────────┐
      ┌──────────────▶│   idle   │───────────────────▶│  queued    │
      │               └──────────┘                    │ (has N     │
      │                     ▲                         │  pending)  │
      │ run ends,           │ run ends,               └─────┬──────┘
      │ queue empty         │ queue still has             flush
      │                     │ items (batch again)            │
      │               ┌─────┴──────┐                         ▼
      └──────────────▶│  running   │◀────────────────────────┘
                      │ (run N)    │
                      └────────────┘
```

### 4.5.3 数据结构新增

- `threads.coordinator_state ENUM('idle','queued','running')`。
- `messages.coordinator_consumed_by_run_id TEXT NULL` —— 记录这条 user message 被哪次 coordinator run 消化。`NULL` 表示未被消化（未入 prompt）或已直接消化（同轮发的首条）。

### 4.5.4 Orchestrator 伪代码

```
onThreadMessage(msg):
    thread = threads[msg.threadId]
    if thread.coordinatorState == 'running':
        thread.coordinatorState = 'queued'   # 若已 queued 保持不变
        # 不启动 run；消息靠 consumed_by_run_id=NULL 被下轮挑走
        return
    if thread.coordinatorState == 'idle':
        startCoordinatorRun(thread, pendingMsgs=[msg])

onCoordinatorRunFinished(thread, finishedRun):
    pending = messages.where(threadId=thread.id, consumed_by_run_id IS NULL, createdAt > finishedRun.startedAt)
    if pending is empty:
        thread.coordinatorState = 'idle'
    else:
        startCoordinatorRun(thread, pendingMsgs=pending)

startCoordinatorRun(thread, pendingMsgs):
    run = createRun(thread)
    for m in pendingMsgs: m.consumed_by_run_id = run.id
    thread.coordinatorState = 'running'
    prompt = buildCoordinatorPrompt(thread.history, batchTrailing=pendingMsgs)
    runner.start(run, prompt)
```

### 4.5.5 UI 影响

- 在 ThreadView 的输入框下方显示 "coordinator is thinking… 3 messages queued" 这类状态提示。
- 可选：在消息气泡右侧加一个"将被下次 coordinator 一起处理"的小 hint。
- 不需要禁止用户输入——永远允许发消息。

### 4.5.6 被打断怎么办

用户可以手动"cancel current coordinator run"：
- 当前 run 被 SIGTERM。
- Orchestrator 立刻按 `onCoordinatorRunFinished` 的流程处理，把 queued 消息和"刚被中断的 run 原本的 trigger 消息"一起重新 batch 启动新的 run（或选择不启动，由用户决定）。
- 可作为一个设置项：cancel 后默认行为 = 不自动重启。

---

## 5. 关键文件改动清单

### 5.1 `packages/contracts/src/domain.ts`

- 新增：`Thread`, `Message`, `Plan`（替代 `CoordinatorProposal`）。
- 废弃并移除：`AgentTeam`, `TeamAgent`, `TeamMessage`, `WorkspaceChannel`（改名为 Thread）, `ChannelMessage`, `TaskMessage`, `CoordinatorProposal`。
- `Task` 添加 `source`, `planId`, `assigneeAgentId`；移除 `teamId`, `teamAgentId`。
- `Run` 无变化。

### 5.2 `packages/server/src/persistence/schema.ts`

- 新增表：`threads`, `messages`, `plans`。
- 废弃表（migration 归档）：`teams`, `team_messages`, `coordinator_proposals`, `workspace_channels`, `channel_messages`, `task_messages`。
- `tasks`：
  - 删除 `team_id`, `team_agent_id`。
  - 新增 `source TEXT NOT NULL DEFAULT 'user'`, `plan_id TEXT`, `assignee_agent_id TEXT`。

### 5.3 `packages/server/src/services/`

新建：
- `task-service.ts`：Task CRUD、column 变更、审批、取消。
- `thread-service.ts`：Thread / Message CRUD、广播、持久化。
- `plan-service.ts`：Plan 创建、审批 CAS、完整子任务事务。
- `orchestrator.ts`：Agent 调度决策、Runner 启停、Runner 输出路由。

拆出：
- `board-service.ts` 逐步瘦身至只保留少量 facade（过渡期），最终删除。
- `team-coordinator-service.ts`：prompt 构造函数迁入 `orchestrator.ts`，或独立为 `prompts/` 目录。
- `team-subtask-service.ts`、`team-pr-service.ts`：合并为 `orchestrator/` 下的 hook。

降级 / 大改：
- `task-scheduler.ts`：**删除所有调度决策**（依赖判断、优先级排序）。只保留"同时跑的 runner 数上限"这类资源约束，改名为 `run-queue.ts`。启动哪个 task 由 coordinator 通过 `start_task_run` tool 调用决定。
- `ai-review-service.ts`：不再由系统自动触发，降级为一个可被 `spawn_agent` 召唤的 reviewer agent 实现。

新增：
- `services/tool-registry.ts`：定义所有 agent 可调 tool 的 schema + handler 绑定。
- `runners/session-bridge.ts`：在 Runner 上增加 `resumeOrStart(sessionKey, msgs[])` 抽象，封装各 runner 的 session 机制。

保持不动：
- `run-lifecycle-service.ts`
- `git-worktree-service.ts`
- `pr-monitor-service.ts`（作为 PR 状态的被动监控者保留）

### 5.4 `packages/server/src/app.ts`

- REST 路由去 `teams/*` 分支，合入 `agents/*` + `threads/*`。
- `/api/teams/:id/proposals/:pid/approve` 等替换为 `/api/plans/:planId/approve`。
- WebSocket 事件合并：`team.*` + `channel.*` + `task_message.*` 合为 `thread.message`, `plan.*`。

### 5.5 `packages/web/src/`

- `components/Board.tsx`：Task 卡片 badge 区分 `source`。
- `components/ThreadView.tsx`（新）：替代 `TeamMessageFeed` + `WorkspaceChannelPage` 中的消息区，统一消息渲染，内联 PlanDraftCard。
- `components/PlanDraftCard.tsx`（新）：在 thread 里渲染 approve/reject UI。
- 废弃：`CoordinatorProposalPanel.tsx`, `TeamsPage.tsx`（或降级为 agent 管理别名）。
- `hooks/useTeams.ts` → `useAgents.ts` 合并；`useCoordination.ts` → `usePlans.ts`。
- `lib/coordination.ts`：删除 `CoordinationScope` 分支，统一走 thread。

### 5.6 迁移脚本

- 单次 migration：
  1. `teams` → 每个 team 的 agents 迁为 `workspace_agents`（如果该 team 只有一个 workspace）。
  2. `team_messages` + `channel_messages` + `task_messages` → `messages`，按来源映射 `kind` 与 `thread_id`。
  3. `coordinator_proposals` → `plans`。
  4. `workspace_channels` → `threads`（字段基本 1:1）。

---

## 6. 事件与原子性

### 6.1 事务边界（针对现状问题 2）

`PlanService.approve(planId)` 必须在单一 SQLite 事务内完成：
1. Plan CAS（pending → approved）。
2. 批量 `tasks` insert。
3. `messages` insert（plan_decision）。

事务成功后再发布事件。若发布事件失败，数据库状态已正确，Reconciler 下次轮询补发 `thread.message` 事件即可。

### 6.2 事件精简

| 旧事件 | 新事件 |
|---|---|
| `team.updated` | `agent.updated` |
| `team.agent.message` | `thread.message` |
| `team.proposal.created` / `.updated` | `plan.created` / `plan.updated` |
| `team.task.created` | 合入 `task.created`（通过 `source="agent_plan"` 区分） |
| `channel.message.created` | `thread.message` |

---

## 7. 验证方式

### 7.1 单元 / 集成测试（必须补齐）

- `plan-service.test.ts`：
  - approve CAS 并发场景（两个 client 同时 approve 只有一个生效）。
  - 事务回滚（子任务创建抛错 → Plan 状态回到 pending，无孤立 task）。
- `orchestrator.test.ts`：
  - Coordinator 输出 JSON → 正确创建 Plan。
  - Coordinator 输出自由文本 → 正确写 chat message，不创建 Plan。
  - Subtask 完成 → task.column 转 review 且 artifact 被写入 task thread。
- `task-service.test.ts`：
  - column 不变量：禁止用户拖到 `running`。
  - `source="agent_plan"` 的 task 删除 Plan 时自动取消。
- 前端 e2e（Playwright 可选）：
  - 用户在 `#coordinator` 发一条"实现 X"，看板上在 N 秒内出现 subtask 卡片。

### 7.2 手工验证路径

1. 启动 dev：`npm run dev`。
2. 创建 workspace → 挂载一个 coordinator + 两个 worker agent。
3. 在 `#coordinator` thread 发话："请实现 README 的 FAQ 章节"。
4. 观察：
   - Thread 出现 `plan_draft` message，展开显示 subtasks。
   - 点 Approve → 看板对应 workspace 下出现 N 个 `todo` 卡片。
   - 卡片自动进入 `running` → `review`，并在 task 内 thread 收到 artifact message。
   - 对其中一张卡 approve → 变 `done`；reject → 变 `done, rejected`。
5. 用户直接在看板创建 Task（`source="user"`）：生命周期独立于 Plan，工作如常。

### 7.3 回归对比

- 对比 migration 前后 `~/.workhorse/state.json` 导出的关键指标：
  - Task 总数、Message 总数（三表合并后总和相等）、Plan 数 = 旧 Proposal 数。

---

## 8. 实施分期

| Phase | 范围 | 可交付 |
|---|---|---|
| P0 | 本 PRD 对齐（本轮） | 本文件 + kilerd 的决策 |
| P1 | contracts + schema + migration（只读双写） | 新表与旧表共存，后端双写 |
| P2 | server services 拆分（Task/Thread/Plan/Orchestrator） | 新 API 上线，旧 API 保留 |
| P3 | web 前端切换 | 新 ThreadView + PlanDraftCard 替换 |
| P4 | 清理旧代码与旧表 | BoardService 删除，legacy team 代码下线 |

每个 Phase 独立可回滚。

---

## 9. 待定 & 风险

- **R1**：如果 D3（Plan 作为 message）通过，需要在 Message payload 里嵌入较复杂的结构（subtasks 数组）。要确认 SQLite TEXT + JSON 列的查询效率可接受——目前 `team_messages.content` 已是 JSON 存储，不是新问题。
- **R2**：`#coordinator` 的"隐藏 coordinator task"被删除后，正在进行中的历史数据需要 migration 把它的 Run 历史挂到新的 `#coordinator` thread，而不是挂到某张 task。
- **R3**：Coordinator 的触发时机（D5）如果改为"手动/@mention"，需要在 UI 里明确入口，否则用户会以为 agent 没反应。
- **R4**：本 PRD 未涵盖 AI Review（`ai-review-service`）与新 thread 的集成方式。若保留，可作为 worker 的一种特化，或作为一种"系统 agent"。建议单独 issue。

---

## 10. 附：当前代码地标（便于实现时回查）

- 现状 Team 流程入口：`packages/server/src/services/board-service.ts:357`（`buildCoordinatorStartOptions`）
- 现状 Proposal 审批：`packages/server/src/services/board-service.ts:3422`（`approveProposal`）
- 现状 Subtask prompt：`packages/server/src/services/team-coordinator-service.ts:346`（`buildSubtaskPrompt`）
- 现状 Schema：`packages/server/src/persistence/schema.ts:93-201`
- 现状 Task column 转换：`packages/server/src/services/run-lifecycle-service.ts:483`（`transitionTaskRunToReview`）
- 现状 domain 类型：`packages/contracts/src/domain.ts:220-456`
- 现状前端 coordination 分支：`packages/web/src/lib/coordination.ts`
