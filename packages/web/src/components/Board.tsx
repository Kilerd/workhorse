import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { Task, TaskColumn, Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";

const columns: Array<{ id: TaskColumn; title: string; tone: string }> = [
  { id: "todo", title: "Todo", tone: "tone-todo" },
  { id: "running", title: "Running", tone: "tone-running" },
  { id: "review", title: "Review", tone: "tone-review" },
  { id: "done", title: "Done", tone: "tone-done" },
  { id: "archived", title: "Archived", tone: "tone-archived" }
];

interface Props {
  tasks: Task[];
  workspaces: Workspace[];
  selectedTaskId: string | null;
  onTaskOpen(taskId: string): void;
  onTaskStart(taskId: string): void;
  onTaskStop(taskId: string): void;
}

function groupTasks(tasks: Task[]): Record<TaskColumn, Task[]> {
  return {
    todo: [],
    running: [],
    review: [],
    done: [],
    archived: []
  } satisfies Record<TaskColumn, Task[]>;
}

function getWorkspaceName(workspaces: Workspace[], workspaceId: string) {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown";
}

function rankBetween(previous?: Task, next?: Task) {
  if (previous && next) {
    return (previous.order + next.order) / 2;
  }

  if (previous) {
    return previous.order + 1024;
  }

  if (next) {
    return next.order - 1024;
  }

  return 1024;
}

export function Board({
  tasks,
  workspaces,
  selectedTaskId,
  onTaskOpen,
  onTaskStart,
  onTaskStop
}: Props) {
  const grouped = columns.reduce((acc, column) => {
    acc[column.id] = tasks
      .filter((task) => task.column === column.id)
      .sort((left, right) => left.order - right.order);
    return acc;
  }, groupTasks(tasks));

  return (
    <section className="board">
      {columns.map((column) => (
        <Droppable droppableId={column.id} key={column.id}>
          {(provided, snapshot) => (
            <article
              className={[
                "column",
                column.tone,
                snapshot.isDraggingOver ? "column-dragging" : ""
              ]
                .filter(Boolean)
                .join(" ")}
              ref={provided.innerRef}
              {...provided.droppableProps}
            >
              <div className="column-header">
                <div>
                  <h2>{column.title}</h2>
                  <p>{grouped[column.id].length} cards</p>
                </div>
              </div>
              <div className="column-list">
                {grouped[column.id].map((task, index) => {
                  const isActive = task.id === selectedTaskId;
                  const workspaceName = getWorkspaceName(workspaces, task.workspaceId);
                  return (
                    <Draggable draggableId={task.id} index={index} key={task.id}>
                      {(dragProvided, dragSnapshot) => (
                        <article
                          className={[
                            "task-card",
                            isActive ? "task-card-active" : "",
                            dragSnapshot.isDragging ? "task-card-dragging" : ""
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          ref={dragProvided.innerRef}
                          {...dragProvided.draggableProps}
                          {...dragProvided.dragHandleProps}
                          role="button"
                          tabIndex={0}
                          onClick={() => onTaskOpen(task.id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onTaskOpen(task.id);
                            }
                          }}
                        >
                          <div className="task-card-top">
                            <strong>{task.title}</strong>
                            <span className={`pill pill-${task.runnerType}`}>{task.runnerType}</span>
                          </div>
                          <p className="task-card-desc">
                            {task.description || "No description"}
                          </p>
                          <div className="task-card-meta">
                            <span>{workspaceName}</span>
                            <span>{formatRelativeTime(task.updatedAt)}</span>
                          </div>
                          <div className="task-card-footer">
                            <span className={`status status-${task.column}`}>{task.column}</span>
                            <span className="task-card-actions">
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onTaskStart(task.id);
                                }}
                              >
                                Start
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onTaskStop(task.id);
                                }}
                              >
                                Stop
                              </button>
                            </span>
                          </div>
                        </article>
                      )}
                    </Draggable>
                  );
                })}
                {provided.placeholder}
              </div>
            </article>
          )}
        </Droppable>
      ))}
    </section>
  );
}
