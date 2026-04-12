# Phase 1: Parallel Task Execution & Task Dependency DAG

- **Status**: Draft
- **Author**: @Product-Manager
- **Date**: 2026-04-13
- **Schema migration**: v5 → v6

## 目标

让 workhorse 支持多任务并行执行 + 任务间依赖关系，从"单任务顺序执行"升级为"多任务有序并行"。这是 Agent Team 路线图的第一阶段。

## 现状分析

### 当前限制

1. **单任务执行** — `RunLifecycleService.activeRuns` 以 `taskId` 为 key，同一时刻只有一个任务在 running
2. **无依赖关系** — `Task` 模型没有 `dependencies` 字段，无法表达"A 完成后 B 才能启动"
3. **无资源管理** — runner 进程无并发上限，多任务同时跑会耗尽系统资源
4. **状态写入无锁** — `StateStore.save()` 使用 atomic rename，但多个并发 read-modify-write 会产生竞态

### 可复用的基础

- `RunnerAdapter` 接口已是无状态的，天然支持多实例
- `EventBus` 广播模型支持多任务事件（事件已带 `taskId` 字段）
- 每个 task 有独立的 git worktree 和 log file，不会互相干扰
- Promise queue 模式（`outputChain`）已在单任务内实现了日志串行化

---

## 数据模型变更

### Task 新增字段

```typescript
interface Task {
  // ... existing fields ...

  /** Task IDs that must be "done" before this task can start */
  dependencies: string[];

  /** Maximum number of rework cycles before escalating */
  maxRetries?: number;
}
```

### 新增 TaskColumn 值

```typescript
type TaskColumn =
  | "backlog"
  | "todo"
  | "blocked"    // NEW: dependencies not met
  | "running"
  | "review"
  | "done"
  | "archived";
```

### Schema migration (v5 → v6)

```typescript
// Backfill: all existing tasks get empty dependencies
task.dependencies = task.dependencies ?? [];
// No column migration needed: existing tasks have no dependencies, won't be "blocked"
```

---

## 核心模块设计

### 1. TaskScheduler（新增）

职责：管理任务执行队列，根据依赖关系和资源限制决定哪些任务可以启动。

```typescript
interface SchedulerConfig {
  /** Max concurrent running tasks (default: 3) */
  maxConcurrent: number;

  /** Max concurrent tasks per runner type */
  maxPerRunner?: Partial<Record<RunnerType, number>>;
}

class TaskScheduler {
  constructor(
    private config: SchedulerConfig,
    private store: StateStore,
    private lifecycle: RunLifecycleService,
    private events: EventBus,
  ) {}

  /** Called when a task moves to "todo" or a dependency completes */
  evaluate(): void;

  /** Check if all dependencies of a task are in "done" column */
  canStart(task: Task): boolean;

  /** Number of currently running tasks */
  activeCount(): number;

  /** Count active runs by runner type (from activeRuns Map, not task column) */
  activeCountByRunner(type: RunnerType): number;
}
```

**调度逻辑：**

1. 收集所有 `column === "todo"` 的 task
2. 过滤出 `canStart(task) === true`（所有 dependencies 已 done）
3. 如果有 task 的 dependencies 未满足但 column 不是 "blocked"，移入 "blocked"
4. 按 `task.order` 排序（优先级 = 位置越靠前越高）
5. 在 `maxConcurrent` 限制内，依次调用 `lifecycle.startTask()`
6. 启动失败的 task 保留在 "todo"，不阻塞其他 task

**触发时机：**

- Task 移入 "todo" 列
- Task 完成（"done"）— 可能解锁被阻塞的 task
- Task 失败 — 依赖它的 task 需要处理
- 依赖关系变更（PUT `/api/tasks/{taskId}/dependencies`）— 取消依赖可能解除 blocked
- 手动调用 `evaluate()`（API 触发）

### 2. DependencyGraph（新增）

职责：维护任务间的 DAG 关系，提供拓扑排序和环检测。

```typescript
class DependencyGraph {
  /** Build graph from current task list */
  static fromTasks(tasks: Task[]): DependencyGraph;

  /** Check for circular dependencies (returns cycle path or null) */
  detectCycle(): string[] | null;

  /** Get tasks that can start (all deps satisfied) */
  getReady(doneTasks: Set<string>): Task[];

  /** Get all tasks transitively blocked by a given task */
  getDownstream(taskId: string): Task[];

  /** Topological sort of all tasks */
  topologicalSort(): Task[];
}
```

**环检测策略：** 在添加依赖时立即检测（API 层校验），而非运行时发现。

### 3. RunLifecycleService 改造

当前的 `activeRuns: Map<string, ActiveRun>` 已经支持多个 entry，但 `startTask()` 方法需要调整：

**移除的限制：**
- 移除"同一 taskId 只能有一个 active run"的检查（保留，这是合理的）
- 移除隐含的"全局只能有一个 running task"假设（如果有的话）

**新增的逻辑：**
- `startTask()` 前检查 `scheduler.canStart(task)` → 如果不满足，抛出 `DEPENDENCIES_NOT_MET` 错误
- `onExit()` callback 中调用 `scheduler.evaluate()` → 完成的 task 可能解锁后续 task

### 4. StateStore 并发安全

当前的 read-modify-write 模式在多任务并发下有竞态风险。

**方案：内部写锁（Mutex）**

```typescript
class StateStore {
  private writeLock = new Mutex();

  async save(): Promise<void> {
    await this.writeLock.acquire();
    try {
      await writeFile(tempPath, JSON.stringify(this.state, null, 2));
      await rename(tempPath, this.stateFile);
    } finally {
      this.writeLock.release();
    }
  }

  /** Atomic read-modify-write helper */
  async updateTask(taskId: string, updater: (task: Task) => Task): Promise<Task> {
    await this.writeLock.acquire();
    try {
      const tasks = this.state.tasks;
      const index = tasks.findIndex(t => t.id === taskId);
      if (index === -1) throw new Error("Task not found");
      tasks[index] = updater(tasks[index]);
      await this.persistUnsafe();
      return tasks[index];
    } finally {
      this.writeLock.release();
    }
  }
}
```

选择 Mutex 而非 optimistic locking 的原因：
- 单进程运行，Mutex 实现简单且性能足够
- JSON 文件没有 version 字段适合 optimistic locking
- 冲突窗口小（毫秒级），Mutex 竞争概率低

推荐使用 `async-mutex` npm 包（轻量、无依赖、TypeScript 原生支持）。

**重要约束：** 持有 Mutex 期间不得 await 长时间操作（如 runner.start()）。Mutex 只保护 state 读写，runner 启动在 Mutex 外。

---

## API 变更

### 新增 endpoints

| Method | Path | 说明 |
|--------|------|------|
| PUT | `/api/tasks/{taskId}/dependencies` | 设置任务依赖列表 |
| GET | `/api/tasks/{taskId}/dependencies` | 获取任务依赖 |
| GET | `/api/scheduler/status` | 获取调度器状态（running count, queued, blocked） |
| POST | `/api/scheduler/evaluate` | 手动触发调度评估 |

### 依赖设置 API

```typescript
// PUT /api/tasks/{taskId}/dependencies
// Body: { dependencies: string[] }
// Response: Task (updated)

// Validation:
// 1. All dependency IDs must exist
// 2. No circular dependency (via DependencyGraph.detectCycle())
// 3. Dependencies must be in same workspace
```

### 现有 API 行为变更

- `POST /api/tasks/{taskId}/start` — 如果依赖未满足，返回 409 Conflict + `DEPENDENCIES_NOT_MET`
- `PATCH /api/tasks/{taskId}` — 移入 "todo" 时触发 `scheduler.evaluate()`
- Task 创建时 `dependencies` 默认为 `[]`

---

## 前端变更

### Task Card

- 显示依赖关系：task card 上展示"blocked by: [task title]"标签
- "blocked" 列新增到 kanban board（位于 todo 和 running 之间）
- 依赖设置 UI：task detail panel 中添加 dependency picker（选择同 workspace 内的其他 task）

### Scheduler Status

- 顶部状态栏显示：`Running: 2/3 | Queued: 5 | Blocked: 1`
- 在 settings 中可配置 `maxConcurrent`

### 依赖可视化（可选，P1 可不做）

- DAG 视图展示任务依赖关系图
- 高亮关键路径

---

## 事件扩展

```typescript
type ServerEvent =
  | // ... existing events ...
  | TaskBlockedEvent        // { type: "task.blocked", taskId, blockedBy: string[] }
  | TaskUnblockedEvent      // { type: "task.unblocked", taskId }
  | SchedulerEvaluatedEvent // { type: "scheduler.evaluated", started: string[], blocked: string[] }
```

---

## 配置

```typescript
interface GlobalSettings {
  // ... existing ...

  scheduler: {
    /** Max concurrent running tasks */
    maxConcurrent: number;  // default: 3

    /** Per-runner concurrency limits */
    maxPerRunner?: {
      claude?: number;   // default: 2
      codex?: number;    // default: 1 (single app-server connection)
      shell?: number;    // default: 3
    };
  };
}
```

**Codex 特殊处理：** Codex runner 依赖 WebSocket 连接到 app-server，当前实现是单连接。Phase 1 限制 `codex.maxConcurrent = 1`，后续版本再支持多 Codex 实例。

---

## 实施步骤

### PR 1: Schema migration + dependency model
- `contracts/src/domain.ts` — Task 新增 `dependencies` 字段、`blocked` column
- `server/src/persistence/state-store.ts` — v5 → v6 migration
- `server/src/services/dependency-graph.ts` — DAG + 环检测 + 拓扑排序
- 单元测试：环检测、拓扑排序、canStart 判断

### PR 2: TaskScheduler + RunLifecycle 改造
- `server/src/services/task-scheduler.ts` — 调度器实现
- `server/src/services/run-lifecycle-service.ts` — 移除单任务限制、集成 scheduler
- `server/src/persistence/state-store.ts` — 写锁 + `updateTask` helper
- 单元测试：并发启动、资源限制、依赖阻塞

### PR 3: API endpoints + 事件
- `server/src/app.ts` — 新增依赖管理和调度器 API
- `contracts/src/events.ts` — 新事件类型
- 集成测试：创建依赖链 → 启动 → 逐个完成 → 验证自动解锁

### PR 4: 前端
- `web/` — blocked 列、dependency picker、scheduler 状态栏
- `api-client/` — 重新生成（如果使用 OpenAPI 自动生成）

---

## 验证清单

- [ ] 3 个独立 task 可以同时 running
- [ ] Task A 依赖 Task B 时，B 未 done → A 显示为 blocked
- [ ] B 完成后 A 自动移入 todo 并被 scheduler 启动
- [ ] 循环依赖被 API 层拒绝（A→B→A）
- [ ] 达到 maxConcurrent 时，新 task 排队等待
- [ ] Codex runner 同时只有 1 个在运行
- [ ] 并发 save() 不丢失数据（Mutex 保护）
- [ ] 前端实时显示 running/blocked/queued 状态变化
- [ ] 现有单任务工作流不受影响（dependencies=[] 行为等价于当前）

---

## 风险

1. **Git 并行操作** — 多个 worktree 同时 fetch 可能导致 git lock 冲突。评估：低风险，fetch 冲突会报错但 runner 会 fail-safe（不影响其他 task）。Phase 1 不处理，Phase 2 可加 fetch queue
2. **系统资源** — 多个 Claude/Codex 进程同时运行可能耗尽内存。缓解：`maxConcurrent` 默认保守值 3，用户可调
3. **日志混乱** — 多 task 同时输出日志，前端需要按 task 隔离展示。当前 EventBus 事件已带 `taskId`，前端按 taskId 过滤即可
4. **状态不一致** — scheduler evaluate 和 task 状态变更之间有窗口。缓解：evaluate 是幂等的，多次调用不会重复启动
