import { cn } from "@/lib/utils";

export type TaskDetailTab = "overview" | "coding" | "review" | "files";

interface TabDef {
  id: TaskDetailTab;
  label: string;
}

const TABS: TabDef[] = [
  { id: "overview", label: "Overview" },
  { id: "coding", label: "Coding" },
  { id: "review", label: "Review" },
  { id: "files", label: "Files" }
];

interface Props {
  active: TaskDetailTab;
  onChange(tab: TaskDetailTab): void;
}

export function TaskTabs({ active, onChange }: Props) {
  return (
    <nav className="flex shrink-0 overflow-x-auto border-b border-border px-4 sm:px-5">
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            className={cn(
              "shrink-0 border-b-2 px-3 py-2.5 text-[0.82rem] font-medium transition-colors",
              isActive
                ? "border-foreground text-foreground"
                : "border-transparent text-[var(--muted)] hover:text-foreground"
            )}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

export function isTaskDetailTab(value: unknown): value is TaskDetailTab {
  return value === "overview" || value === "coding" || value === "review" || value === "files";
}
