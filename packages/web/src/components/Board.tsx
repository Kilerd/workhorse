import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime, titleCase } from "@/lib/format";
import { BOARD_COLUMNS, type DisplayTask, type DisplayTaskColumn } from "@/lib/task-view";
import { TaskActionBar } from "./TaskActionBar";

interface Props {
  tasks: DisplayTask[];
  workspaces: Workspace[];
  selectedTaskId: string | null;
  onTaskOpen(taskId: string): void;
  onPlan(taskId: string): void;
  onTaskStart(taskId: string): void;
  onTaskStop(taskId: string): void;
  onMoveToTodo(taskId: string): void;
  onMarkDone(taskId: string): void;
  onArchive(taskId: string): void;
}

function groupTasks(): Record<DisplayTaskColumn, DisplayTask[]> {
  return {
    backlog: [],
    todo: [],
    running: [],
    review: [],
    done: [],
    archived: []
  };
}

export function Board({
  tasks,
  workspaces,
  selectedTaskId,
  onTaskOpen,
  onPlan,
  onTaskStart,
  onTaskStop,
  onMoveToTodo,
  onMarkDone,
  onArchive
}: Props) {
  const grouped = BOARD_COLUMNS.reduce((acc, column) => {
    acc[column.id] = tasks
      .filter((task) => task.column === column.id)
      .sort((left, right) => left.order - right.order);
    return acc;
  }, groupTasks());

  return (
    <section className="board">
      {BOARD_COLUMNS.map((column) => (
        <Droppable droppableId={column.id} key={column.id}>
          {(provided, snapshot) => (
            <article
              className={[
                "column",
                snapshot.isDraggingOver ? "column-dragging" : ""
              ]
                .filter(Boolean)
                .join(" ")}
            >
              <div className="column-header">
                <h2>{column.title}</h2>
                <span>{grouped[column.id].length} cards</span>
              </div>

              <div
                className="column-list"
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {grouped[column.id].map((task, index) => {
                  const isActive = task.id === selectedTaskId;
                  const workspace = workspaces.find((entry) => entry.id === task.workspaceId);
                  const workspaceName = workspace?.name ?? "Unknown";
                  const showWorktree = workspace?.isGitRepo ?? false;

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
                          <div className="task-card-head">
                            <div className="task-card-title">
                              <strong>{task.title}</strong>
                              <p className="task-card-desc">
                                {task.description || "No description"}
                              </p>
                            </div>
                            <span className={`pill pill-${task.runnerType}`}>
                              {task.runnerType.toUpperCase()}
                            </span>
                          </div>

                          <div className="task-card-tags">
                            <span className="meta-token">{workspaceName}</span>
                            <span className={`status status-${task.column}`}>
                              {titleCase(task.column)}
                            </span>
                            {showWorktree ? (
                              <span className={`status status-worktree-${task.worktree.status}`}>
                                {titleCase(task.worktree.status)}
                              </span>
                            ) : null}
                          </div>

                          {task.column === "review" && task.pullRequestUrl ? (
                            <div className="task-card-pr">
                              <span className="meta-token">PR</span>
                              <a
                                className="task-pr-link"
                                href={task.pullRequestUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                {task.pullRequestUrl}
                              </a>
                            </div>
                          ) : null}

                          <div className="task-card-footer">
                            <span className="task-card-time">
                              Updated {formatRelativeTime(task.updatedAt)}
                            </span>
                            <TaskActionBar
                              column={task.column}
                              compact
                              onPlan={() => onPlan(task.id)}
                              onStart={() => onTaskStart(task.id)}
                              onStop={() => onTaskStop(task.id)}
                              onMoveToTodo={() => onMoveToTodo(task.id)}
                              onMarkDone={() => onMarkDone(task.id)}
                              onArchive={() => onArchive(task.id)}
                            />
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
