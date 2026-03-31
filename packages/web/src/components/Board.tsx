import { Draggable, Droppable } from "@hello-pangea/dnd";
import type { Workspace } from "@workhorse/contracts";

import { formatRelativeTime } from "@/lib/format";
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

function getWorkspaceName(workspaces: Workspace[], workspaceId: string) {
  return workspaces.find((workspace) => workspace.id === workspaceId)?.name ?? "Unknown";
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
