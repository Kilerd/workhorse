import type {
  Message,
  MessageKind,
  MessageSender,
  Run,
  RunLogEntry,
  ServerEvent,
  Task,
  Thread,
  WorkspaceAgent
} from "@workhorse/contracts";

import type { StateStore } from "../persistence/state-store.js";
import type { EventBus } from "../ws/event-bus.js";
import type { ThreadService } from "./thread-service.js";

export interface TaskThreadBridgeDeps {
  store: StateStore;
  events: EventBus;
  threads: ThreadService;
  sendTaskInput?(taskId: string, input: { text: string }): Promise<unknown>;
  triggerCoordinator?(threadId: string): Promise<void>;
}

interface MentionResolution {
  mentions: string[];
  addressedAgentIds: string[];
  coordinatorAgentId?: string;
}

function readObjectPayload(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function readTextPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  const object = readObjectPayload(payload);
  return typeof object.text === "string" ? object.text : "";
}

function readStringArray(payload: Record<string, unknown>, key: string): string[] {
  const value = payload[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeMention(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export class TaskThreadBridge {
  private unsubscribe?: () => void;

  public constructor(private readonly deps: TaskThreadBridgeDeps) {}

  public start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.deps.events.subscribe((event) => {
      void this.onServerEvent(event).catch((error) => {
        console.warn("[task-thread-bridge] event handling failed", error);
      });
    });
  }

  public stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  public buildUserPayload(thread: Thread, text: string): Record<string, unknown> {
    if (thread.kind !== "task") {
      return { text };
    }

    const resolution = this.resolveMentions(thread, text);
    return {
      text,
      ...(resolution.mentions.length > 0 ? { mentions: resolution.mentions } : {}),
      ...(resolution.addressedAgentIds.length > 0
        ? {
            addressedAgentIds: resolution.addressedAgentIds,
            pendingDeliveryAgentIds: resolution.addressedAgentIds.filter(
              (agentId) => agentId !== resolution.coordinatorAgentId
            )
          }
        : {})
    };
  }

  public async routeUserMessage(thread: Thread, message: Message): Promise<void> {
    if (thread.kind !== "task" || !thread.taskId || message.sender.type !== "user") {
      return;
    }

    const payload = readObjectPayload(message.payload);
    const text = readTextPayload(payload);
    const addressedAgentIds = readStringArray(payload, "addressedAgentIds");
    if (addressedAgentIds.length === 0) {
      return;
    }

    const task = this.findTask(thread.taskId);
    if (!task) {
      return;
    }

    const coordinator = this.findCoordinatorAgent(task.workspaceId);
    if (coordinator && addressedAgentIds.includes(coordinator.id)) {
      await this.notifyCoordinator(task, thread, message, "task_thread.mention");
    }

    const activeRun = this.findActiveRun(task.id);
    const nonCoordinatorAgentIds = addressedAgentIds.filter(
      (agentId) => agentId !== coordinator?.id
    );
    const activeAgentId = activeRun?.metadata?.reviewAgentId ?? task.assigneeAgentId;
    if (activeRun?.runnerType === "codex" && nonCoordinatorAgentIds.includes(activeAgentId ?? "")) {
      await this.sendTaskInput(task.id, text);
      this.markDelivered(message, activeRun.id, activeAgentId);
    }
  }

  private async onServerEvent(event: ServerEvent): Promise<void> {
    if (event.type === "run.started") {
      this.mirrorRunStarted(event.taskId, event.run);
      return;
    }

    if (event.type === "run.output") {
      this.mirrorRunOutput(event.taskId, event.runId, event.entry);
      return;
    }

    if (event.type === "run.finished") {
      await this.handleRunFinished(event.task, event.run);
    }
  }

  private mirrorRunStarted(taskId: string, run: Run): void {
    const task = this.findTask(taskId);
    if (!task) {
      return;
    }
    const thread = this.findTaskThread(task);
    if (!thread || this.hasMirroredRunEvent(thread.id, run.id, "started")) {
      return;
    }

    const agentName = this.findAgentName(task.workspaceId, run.metadata?.reviewAgentId ?? task.assigneeAgentId);
    this.deps.threads.appendMessage({
      threadId: thread.id,
      sender: { type: "system" },
      kind: "status",
      payload: {
        text: `${agentName ?? run.runnerType} run started.`,
        metadata: {
          mirroredFromRunLog: "true",
          runId: run.id,
          runEvent: "started",
          runnerType: run.runnerType
        }
      }
    });
  }

  private mirrorRunOutput(taskId: string, runId: string, entry: RunLogEntry): void {
    if (entry.kind === "user") {
      return;
    }

    const task = this.findTask(taskId);
    if (!task) {
      return;
    }
    const thread = this.findTaskThread(task);
    if (!thread) {
      return;
    }
    if (this.hasMirroredEntry(thread.id, entry.id)) {
      return;
    }

    const message = this.runLogEntryToMessage(thread.id, task, runId, entry);
    this.deps.threads.appendMessage({
      threadId: message.threadId,
      sender: message.sender,
      kind: message.kind,
      payload: message.payload
    });
  }

  private runLogEntryToMessage(
    threadId: string,
    task: Task,
    runId: string,
    entry: RunLogEntry
  ): Pick<Message, "threadId" | "sender" | "kind" | "payload"> {
    const reviewAgentId = this.findRun(runId)?.metadata?.reviewAgentId;
    const agentId = reviewAgentId ?? task.assigneeAgentId;
    const sender: MessageSender =
      agentId && entry.kind !== "system"
        ? { type: "agent", agentId }
        : { type: "system" };
    const kind: MessageKind =
      entry.kind === "agent"
        ? "chat"
        : entry.kind === "tool_call" || entry.kind === "tool_output"
          ? entry.kind
          : "status";

    return {
      threadId,
      sender,
      kind,
      payload: {
        text: entry.text,
        ...(entry.title ? { title: entry.title, name: entry.title } : {}),
        stream: entry.stream,
        source: entry.source,
        metadata: {
          ...(entry.metadata ?? {}),
          mirroredFromRunLog: "true",
          runId,
          runEntryId: entry.id,
          entryKind: entry.kind,
          entryStream: entry.stream,
          ...(entry.source ? { source: entry.source } : {})
        }
      }
    };
  }

  private async handleRunFinished(task: Task, run: Run): Promise<void> {
    const thread = this.findTaskThread(task);
    const coordinator = this.findCoordinatorAgent(task.workspaceId);
    if (!thread || !coordinator) {
      return;
    }

    const entries = await this.deps.store.readLogEntries(run.id);
    const lastAgentText =
      entries
        .filter((entry) => entry.kind === "agent")
        .map((entry) => entry.text.trim())
        .filter(Boolean)
        .at(-1) ?? "";
    const mentionedCoordinator = /@coordinator\b/iu.test(lastAgentText);

    if (!mentionedCoordinator) {
      this.deps.threads.appendMessage({
        threadId: thread.id,
        sender: { type: "system" },
        kind: "status",
        payload: {
          text: `Run ${run.id} finished without an @coordinator mention; notifying coordinator.`,
          kind: "coordinator_completion_fallback",
          taskId: task.id,
          runId: run.id
        }
      });
    }

    await this.notifyCoordinator(task, thread, undefined, "task_thread.run_finished", {
      runId: run.id,
      runStatus: run.status,
      runnerType: run.runnerType,
      mentionedCoordinator
    });
  }

  private async notifyCoordinator(
    task: Task,
    taskThread: Thread,
    sourceMessage: Message | undefined,
    kind: string,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const coordinatorThread = this.findCoordinatorThread(task.workspaceId);
    if (!coordinatorThread) {
      return;
    }

    this.deps.threads.appendMessage({
      threadId: coordinatorThread.id,
      sender: { type: "system" },
      kind: "system_event",
      payload: {
        kind,
        taskId: task.id,
        taskTitle: task.title,
        taskThreadId: taskThread.id,
        sourceMessageId: sourceMessage?.id,
        text: sourceMessage ? readTextPayload(sourceMessage.payload) : undefined,
        ...extra
      }
    });

    await this.deps.triggerCoordinator?.(coordinatorThread.id);
  }

  private resolveMentions(thread: Thread, text: string): MentionResolution {
    const agents = this.deps.store.listWorkspaceAgents(thread.workspaceId);
    const task = thread.taskId ? this.findTask(thread.taskId) : undefined;
    const coordinator = agents.find((agent) => agent.role === "coordinator");
    const assignee = task?.assigneeAgentId
      ? agents.find((agent) => agent.id === task.assigneeAgentId)
      : undefined;
    const mentioned = new Set<string>();
    const addressed = new Set<string>();
    const lowerText = normalizeMention(text);

    for (const match of text.matchAll(/@([A-Za-z0-9_-]+)/gu)) {
      const token = normalizeMention(match[1] ?? "");
      if (!token) continue;
      mentioned.add(token);
      this.resolveMentionToken(token, agents, {
        coordinator,
        assignee
      }).forEach((agentId) => addressed.add(agentId));
    }

    for (const agent of agents) {
      const nameMention = `@${normalizeMention(agent.name)}`;
      if (nameMention.length > 1 && lowerText.includes(nameMention)) {
        mentioned.add(normalizeMention(agent.name));
        addressed.add(agent.id);
      }
      const idMention = `@${normalizeMention(agent.id)}`;
      if (lowerText.includes(idMention)) {
        mentioned.add(normalizeMention(agent.id));
        addressed.add(agent.id);
      }
    }

    return {
      mentions: [...mentioned],
      addressedAgentIds: [...addressed],
      coordinatorAgentId: coordinator?.id
    };
  }

  private resolveMentionToken(
    token: string,
    agents: WorkspaceAgent[],
    aliases: {
      coordinator?: WorkspaceAgent;
      assignee?: WorkspaceAgent;
    }
  ): string[] {
    switch (token) {
      case "coordinator":
        return aliases.coordinator ? [aliases.coordinator.id] : [];
      case "worker":
      case "assignee":
        return aliases.assignee ? [aliases.assignee.id] : [];
      default: {
        const match = agents.find(
          (agent) =>
            normalizeMention(agent.id) === token ||
            normalizeMention(agent.name) === token
        );
        return match ? [match.id] : [];
      }
    }
  }

  private markDelivered(
    message: Message,
    runId: string,
    agentId: string | undefined
  ): void {
    if (!agentId) return;
    const payload = readObjectPayload(message.payload);
    const pending = readStringArray(payload, "pendingDeliveryAgentIds").filter(
      (id) => id !== agentId
    );
    const delivered = new Set(readStringArray(payload, "deliveredAgentIds"));
    delivered.add(agentId);

    const updated = this.deps.store.updateMessagePayload(message.id, {
      ...payload,
      pendingDeliveryAgentIds: pending,
      deliveredAgentIds: [...delivered],
      deliveredRunId: runId
    });
    if (updated) {
      this.deps.events.publish({
        type: "thread.message",
        threadId: updated.threadId,
        message: updated
      });
    }
  }

  private async sendTaskInput(taskId: string, text: string): Promise<void> {
    try {
      await this.deps.sendTaskInput?.(taskId, { text });
    } catch (error) {
      console.warn("[task-thread-bridge] task input delivery failed", error);
    }
  }

  private hasMirroredEntry(threadId: string, entryId: string): boolean {
    return this.deps.store
      .listMessages(threadId)
      .some((message) => {
        const metadata = readObjectPayload(readObjectPayload(message.payload).metadata);
        return metadata.runEntryId === entryId;
      });
  }

  private hasMirroredRunEvent(
    threadId: string,
    runId: string,
    runEvent: string
  ): boolean {
    return this.deps.store
      .listMessages(threadId)
      .some((message) => {
        const metadata = readObjectPayload(readObjectPayload(message.payload).metadata);
        return metadata.runId === runId && metadata.runEvent === runEvent;
      });
  }

  private findTask(taskId: string): Task | undefined {
    return this.deps.store.listTasks().find((task) => task.id === taskId);
  }

  private findRun(runId: string): Run | undefined {
    return this.deps.store.listRuns().find((run) => run.id === runId);
  }

  private findActiveRun(taskId: string): Run | undefined {
    return this.deps.store
      .listRuns()
      .find((run) => run.taskId === taskId && run.status === "running");
  }

  private findTaskThread(task: Task): Thread | undefined {
    return this.deps.store
      .listThreadsByWorkspace(task.workspaceId)
      .find((thread) => thread.kind === "task" && thread.taskId === task.id && !thread.archivedAt);
  }

  private findCoordinatorAgent(workspaceId: string): WorkspaceAgent | undefined {
    return this.deps.store
      .listWorkspaceAgents(workspaceId)
      .find((agent) => agent.role === "coordinator");
  }

  private findAgentName(
    workspaceId: string,
    agentId: string | undefined
  ): string | undefined {
    if (!agentId) return undefined;
    return this.deps.store
      .listWorkspaceAgents(workspaceId)
      .find((agent) => agent.id === agentId)?.name;
  }

  private findCoordinatorThread(workspaceId: string): Thread | undefined {
    return this.deps.store
      .listThreadsByWorkspace(workspaceId)
      .filter(
        (thread) =>
          thread.kind === "coordinator" &&
          !thread.archivedAt &&
          Boolean(thread.coordinatorAgentId)
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }
}
