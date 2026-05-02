import type {
  WorkspacePromptTemplateId,
  WorkspacePromptTemplates
} from "./domain.js";

export interface WorkspacePromptTemplateVariable {
  description: string;
  key: string;
  token: string;
}

export interface WorkspacePromptTemplateDefinition {
  defaultTemplate: string;
  description: string;
  label: string;
  previewValues: Record<string, string>;
  variables: WorkspacePromptTemplateVariable[];
}

export const WORKSPACE_PROMPT_TEMPLATE_IDS = [
  "coding"
] as const satisfies WorkspacePromptTemplateId[];

const DEFAULT_CODING_TEMPLATE = [
  "Task: {{taskTitle}}",
  "",
  "{{taskDescriptionBlock}}",
  "",
  "{{taskPlanBlock}}",
  "",
  "{{taskPrompt}}",
  "",
  "{{gitRequirements}}"
].join("\n");

export const WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS = {
  coding: {
    label: "Coding Prompt",
    description:
      "Wraps each Codex coding run and can inject reusable repo-specific instructions.",
    defaultTemplate: DEFAULT_CODING_TEMPLATE,
    variables: [
      {
        key: "taskPrompt",
        token: "{{taskPrompt}}",
        description: "The task-specific prompt entered on the task itself."
      },
      {
        key: "taskTitle",
        token: "{{taskTitle}}",
        description: "Current task title."
      },
      {
        key: "taskDescription",
        token: "{{taskDescription}}",
        description: "Current task description."
      },
      {
        key: "taskDescriptionBlock",
        token: "{{taskDescriptionBlock}}",
        description: "Preformatted task description block."
      },
      {
        key: "taskPlan",
        token: "{{taskPlan}}",
        description: "Saved implementation plan for the task."
      },
      {
        key: "taskPlanBlock",
        token: "{{taskPlanBlock}}",
        description: "Preformatted implementation plan block."
      },
      {
        key: "workingDirectory",
        token: "{{workingDirectory}}",
        description: "Workspace or worktree path used for the run."
      },
      {
        key: "baseRef",
        token: "{{baseRef}}",
        description: "Base branch or ref for Git-backed tasks."
      },
      {
        key: "branchName",
        token: "{{branchName}}",
        description: "Generated task branch name for Git-backed tasks."
      },
      {
        key: "gitRequirements",
        token: "{{gitRequirements}}",
        description:
          "The built-in Git/PR workflow requirements block for Git-backed workspaces."
      }
    ],
    previewValues: {
      taskPrompt: "请完成用户请求的任务。",
      taskTitle: "自定义工作区提示词设置",
      taskDescription: "让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。",
      taskDescriptionBlock:
        "Task description:\n让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。",
      taskPlan: ["1. Add prompt template contracts", "2. Wire server builders", "3. Build settings UI preview"].join("\n"),
      taskPlanBlock: [
        "Implementation plan:",
        "1. Add prompt template contracts",
        "2. Wire server builders",
        "3. Build settings UI preview"
      ].join("\n"),
      workingDirectory: "/Users/you/projects/workhorse",
      baseRef: "origin/main",
      branchName: "task/custom-workspace-prompts",
      gitRequirements: [
        "Git requirements:",
        "- Work on branch `task/custom-workspace-prompts` from `origin/main`.",
        "- You are responsible for creating any commits, pushing the branch, and opening or updating the GitHub PR yourself before finishing.",
        "- Use Conventional Commits for commit messages."
      ].join("\n")
    }
  }
} satisfies Record<WorkspacePromptTemplateId, WorkspacePromptTemplateDefinition>;

export const DEFAULT_WORKSPACE_PROMPT_TEMPLATES = Object.fromEntries(
  WORKSPACE_PROMPT_TEMPLATE_IDS.map((templateId) => [
    templateId,
    WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS[templateId].defaultTemplate
  ])
) as Record<WorkspacePromptTemplateId, string>;

export function resolveWorkspacePromptTemplate(
  templateId: WorkspacePromptTemplateId,
  templates?: WorkspacePromptTemplates | null
): string {
  const customTemplate = templates?.[templateId];
  return typeof customTemplate === "string" && customTemplate.trim()
    ? customTemplate
    : DEFAULT_WORKSPACE_PROMPT_TEMPLATES[templateId];
}

export function resolveTemplate(
  template: string,
  variables: Record<string, string | number | null | undefined>
): string {
  return template
    .replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => {
      if (!Object.prototype.hasOwnProperty.call(variables, key)) {
        return `{{${key}}}`;
      }
      const value = variables[key];
      return value === undefined || value === null ? "" : String(value);
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function previewTemplate(
  templateId: WorkspacePromptTemplateId,
  template?: string | null
): string {
  const definition = WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS[templateId];
  return resolveTemplate(
    template?.trim() ? template : definition.defaultTemplate,
    definition.previewValues
  );
}
