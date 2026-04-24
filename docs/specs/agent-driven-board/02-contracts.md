# Spec 02 — Contracts: new domain types + API schemas

## Goal

Add TypeScript domain types (`Thread`, `Message`, `Plan`, `AgentSession`) and request/response schemas for their REST + WebSocket surface. Legacy types (`AgentTeam`, `TeamAgent`, `TeamMessage`, `WorkspaceChannel`, `ChannelMessage`, `TaskMessage`, `CoordinatorProposal`) stay unchanged.

`Task` type gains the three new fields from Spec 01 as optional (to keep legacy call sites compiling).

## Prerequisites

- Spec 01 landed (DB has the new columns).

## Scope

- `packages/contracts/src/domain.ts` — new interfaces.
- `packages/contracts/src/api.ts` — new request/response bodies.
- `packages/contracts/src/events.ts` — new WS event types.
- `packages/api-client/` — regenerate via `npm run generate:client`.

## New types (domain.ts)

```ts
export type ThreadKind = "coordinator" | "task" | "direct";
export type CoordinatorState = "idle" | "queued" | "running";

export interface Thread {
  id: string;
  workspaceId: string;
  kind: ThreadKind;
  taskId?: string;
  coordinatorAgentId?: string;
  coordinatorState: CoordinatorState;
  createdAt: string;
  archivedAt?: string;
}

export type MessageKind =
  | "chat"
  | "status"
  | "artifact"
  | "plan_draft"
  | "plan_decision"
  | "system_event";

export type MessageSender =
  | { type: "user" }
  | { type: "agent"; agentId: string }
  | { type: "system" };

export interface Message {
  id: string;
  threadId: string;
  sender: MessageSender;
  kind: MessageKind;
  payload: unknown; // narrowed per kind in typia schemas
  consumedByRunId?: string;
  createdAt: string;
}

export type PlanStatus = "pending" | "approved" | "rejected" | "superseded";

export interface PlanDraft {
  title: string;
  description: string;
  assigneeAgentId?: string;
  dependsOn?: string[]; // references to other drafts' titles within the same plan
}

export interface Plan {
  id: string;
  threadId: string;
  proposerAgentId: string;
  status: PlanStatus;
  drafts: PlanDraft[];
  approvedAt?: string;
  createdAt: string;
}

export interface AgentSession {
  id: string;
  workspaceId: string;
  agentId: string;
  threadId: string;
  runnerSessionKey?: string;
  createdAt: string;
}
```

## Task type extension

Add optional fields:

```ts
export interface Task {
  // ...existing...
  source?: "user" | "agent_plan"; // default "user" when missing
  planId?: string;
  assigneeAgentId?: string;
}
```

Legacy `teamId` / `teamAgentId` stay optional as before.

## API additions (api.ts)

- `GET /api/workspaces/:wsId/threads` → `Thread[]`
- `POST /api/threads/:threadId/messages` → `{ content, kind?: "chat" }`
- `GET /api/threads/:threadId/messages?after=<id>&limit=` → `Message[]`
- `POST /api/plans/:planId/approve` → `Plan`
- `POST /api/plans/:planId/reject` → `Plan`

Legacy endpoints (`/api/teams/...`, `/api/workspaces/:wsId/channels/...`) stay; we'll retire them in Spec 09.

## Event additions (events.ts)

```ts
| { type: "thread.message"; threadId: string; message: Message }
| { type: "thread.updated"; threadId: string; thread: Thread }
| { type: "plan.created"; planId: string; plan: Plan }
| { type: "plan.updated"; planId: string; plan: Plan }
```

## Verification

- `npm run generate:client` succeeds; no TS errors in `api-client` or `web`.
- `npm run typecheck` in root: green.
- Unit test: typia validator accepts a valid `Message` of each `kind` and rejects an invalid payload.

## Out of scope

- Wiring services to emit these events (Spec 04+).
- Removing legacy types (Spec 09).
