import { describe, expect, it } from "vitest";

import {
  CoordinatorSubtaskParseError,
  buildCoordinatorPrompt,
  buildWorkspaceChannelPrompt,
  buildSubtaskPrompt,
  buildTeamAgentMessageEvent,
  buildTeamTaskCreatedEvent,
  parseCoordinatorChannelResult,
  parseCoordinatorSubtasks,
  truncateTeamMessagePayload
} from "./team-coordinator-service.js";

describe("team coordinator service", () => {
  it("builds the coordinator prompt with explicit system boundaries", () => {
    const prompt = buildCoordinatorPrompt({
      agents: [
        {
          id: "agent-coordinator",
          name: "Planner",
          role: "coordinator",
          runnerType: "codex",
          description: "Breaks work into subtasks"
        },
        {
          id: "agent-worker",
          name: "Builder",
          role: "worker",
          runnerType: "claude",
          description: "Implements UI work"
        }
      ],
      userPrompt: "Create the next team execution plan."
    });

    expect(prompt).toContain("--- SYSTEM CONTEXT ---");
    expect(prompt).toContain("- coordinator: Planner (codex, Breaks work into subtasks)");
    expect(prompt).toContain("- worker: Builder (claude, Implements UI work)");
    expect(prompt).toContain("Output format: JSON array of subtasks:");
    expect(prompt).toContain("--- YOUR TASK ---");
    expect(prompt).toContain("Create the next team execution plan.");
  });

  it("parses coordinator subtasks from fenced JSON output", () => {
    const subtasks = parseCoordinatorSubtasks([
      "Here is the plan:",
      "```json",
      JSON.stringify(
        [
          {
            title: "Add coordinator service",
            description: "Introduce a service for parsing coordinator output.",
            assignedAgent: "worker-a",
            dependencies: []
          },
          {
            title: "Publish team event",
            description: "Emit the creation event after subtask sync.",
            assignedAgent: "worker-b",
            dependencies: ["Add coordinator service"]
          }
        ],
        null,
        2
      ),
      "```"
    ].join("\n"));

    expect(subtasks).toEqual([
      {
        title: "Add coordinator service",
        description: "Introduce a service for parsing coordinator output.",
        assignedAgent: "worker-a",
        dependencies: []
      },
      {
        title: "Publish team event",
        description: "Emit the creation event after subtask sync.",
        assignedAgent: "worker-b",
        dependencies: ["Add coordinator service"]
      }
    ]);
  });

  it("throws a typed parse error for invalid coordinator output", () => {
    expect(() => parseCoordinatorSubtasks('{"title":"not an array"}')).toThrow(
      CoordinatorSubtaskParseError
    );
  });

  it("allows workspace coordinator prompts to reply in plain text unless proposing tasks", () => {
    const prompt = buildWorkspaceChannelPrompt({
      agents: [
        {
          id: "agent-coordinator",
          name: "Coordinator",
          role: "coordinator",
          runnerType: "codex"
        }
      ],
      transcript: "User: 你好，你是谁？"
    });

    expect(prompt).toContain("For normal conversation, reply with plain text only.");
    expect(prompt).toContain("Only when you are ready to propose new top-level tasks");
  });

  it("parses plain-text workspace coordinator replies without requiring JSON", () => {
    const result = parseCoordinatorChannelResult("你好，我是这个 workspace 的 coordinator。");

    expect(result).toEqual({
      reply: "你好，我是这个 workspace 的 coordinator。",
      tasks: []
    });
  });

  it("parses structured workspace coordinator task proposals", () => {
    const result = parseCoordinatorChannelResult(
      JSON.stringify({
        reply: "我已经拆出了两个任务。",
        tasks: [
          {
            title: "Task A",
            description: "First task",
            assignedAgent: "Coordinator",
            dependencies: []
          },
          {
            title: "Task B",
            description: "Second task",
            assignedAgent: "Coordinator",
            dependencies: ["Task A"]
          }
        ]
      })
    );

    expect(result).toEqual({
      reply: "我已经拆出了两个任务。",
      tasks: [
        {
          title: "Task A",
          description: "First task",
          assignedAgent: "Coordinator",
          dependencies: []
        },
        {
          title: "Task B",
          description: "Second task",
          assignedAgent: "Coordinator",
          dependencies: ["Task A"]
        }
      ]
    });
  });

  it("injects team context and historical messages into subtask prompts", () => {
    const prompt = buildSubtaskPrompt({
      teamName: "Delivery Team",
      parentTaskTitle: "Ship Agent Team PR2",
      agents: [
        {
          id: "agent-coordinator",
          name: "Planner",
          role: "coordinator",
          runnerType: "codex"
        },
        {
          id: "agent-worker",
          name: "Builder",
          role: "worker",
          runnerType: "claude",
          description: "Owns frontend tasks"
        }
      ],
      messages: [
        {
          fromAgentId: "agent-coordinator",
          messageType: "context",
          payload: "Focus on the event bus and keep payloads under 10KB."
        }
      ],
      subtaskTitle: "Implement coordinator parser",
      subtaskDescription: "Parse JSON subtasks and reject malformed payloads.",
      userPrompt: "Implement the assigned subtask."
    });

    expect(prompt).toContain("Team: Delivery Team");
    expect(prompt).toContain("Parent task: Ship Agent Team PR2");
    expect(prompt).toContain("Historical team messages:");
    expect(prompt).toContain(
      "- [context] agent-coordinator -> broadcast: Focus on the event bus and keep payloads under 10KB."
    );
    expect(prompt).toContain("Assigned subtask:");
    expect(prompt).toContain("Title: Implement coordinator parser");
    expect(prompt).toContain("--- YOUR TASK ---");
  });

  it("truncates team message payloads to the configured byte budget", () => {
    const truncated = truncateTeamMessagePayload("x".repeat(10_500));
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(10 * 1024);
    expect(truncated).toContain("[truncated]");
  });

  it("truncates multibyte payloads on code point boundaries", () => {
    const truncated = truncateTeamMessagePayload("你好".repeat(6_000), 128);
    expect(Buffer.byteLength(truncated, "utf8")).toBeLessThanOrEqual(128);
    expect(truncated).toContain("[truncated]");
    expect(truncated).not.toContain("\uFFFD");
  });

  it("rejects coordinator outputs with more than 8 subtasks", () => {
    const payload = JSON.stringify(
      Array.from({ length: 9 }, (_, index) => ({
        title: `Task ${index + 1}`,
        description: "Do the work.",
        assignedAgent: "Worker",
        dependencies: []
      }))
    );

    expect(() => parseCoordinatorSubtasks(payload)).toThrow(
      "Coordinator output 9 subtasks, maximum is 8"
    );
  });

  it("builds the new team events with normalized payloads", () => {
    const messageEvent = buildTeamAgentMessageEvent({
      teamId: "team-1",
      parentTaskId: "task-parent",
      fromAgentId: "agent-coordinator",
      messageType: "status",
      payload: "Subtask planning complete."
    });
    const createdEvent = buildTeamTaskCreatedEvent({
      teamId: "team-1",
      parentTaskId: "task-parent",
      subtasks: [
        { taskId: "task-a", title: "Task A", agentName: "Worker A" },
        { taskId: "task-b", title: "Task B", agentName: "Worker B" }
      ]
    });

    expect(messageEvent).toEqual({
      type: "team.agent.message",
      teamId: "team-1",
      parentTaskId: "task-parent",
      fromAgentId: "agent-coordinator",
      messageType: "status",
      payload: "Subtask planning complete."
    });
    expect(createdEvent).toEqual({
      type: "team.task.created",
      teamId: "team-1",
      parentTaskId: "task-parent",
      subtasks: [
        { taskId: "task-a", title: "Task A", agentName: "Worker A" },
        { taskId: "task-b", title: "Task B", agentName: "Worker B" }
      ]
    });
  });
});
