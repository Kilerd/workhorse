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
  "plan",
  "coding",
  "review",
  "reviewFollowUp"
] as const satisfies WorkspacePromptTemplateId[];

const DEFAULT_PLAN_TEMPLATE = [
  "Task: {{taskTitle}}",
  "",
  "{{taskDescriptionBlock}}",
  "",
  "Working directory: {{workingDirectory}}",
  "",
  "Base ref: {{baseRef}}",
  "Task branch: {{branchName}}",
  "",
  "You are a planning assistant. Thoroughly explore the codebase, understand existing patterns and architecture, then create a detailed implementation plan.",
  "Do NOT implement anything or modify any files. Only output the plan.",
  "",
  "Your plan MUST include the following sections in markdown format:",
  "",
  "## Motivation",
  "Why this change is needed. What problem does it solve or what value does it add.",
  "",
  "## Current State",
  "How the relevant code works today. Key files, functions, data flows involved.",
  "",
  "## Proposed Changes",
  "Detailed list of every file and function to modify or create, with a clear description of what changes and why.",
  "For each change, specify:",
  "- File path",
  "- What to add / modify / remove",
  "- The reasoning behind the change",
  "",
  "## Impact & Scope",
  "Which modules, APIs, tests, or downstream consumers are affected by this change.",
  "",
  "## Risks & Edge Cases",
  "Potential pitfalls, race conditions, backward compatibility concerns, or tricky edge cases to watch for.",
  "",
  "## Verification",
  "How to verify the change works: which tests to add or update, manual checks, commands to run.",
  "",
  "## Exit Criteria",
  "Concrete definition of done - what must be true for this task to be considered complete."
].join("\n");

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

const DEFAULT_REVIEW_TEMPLATE = [
  "You are the reviewer agent for this engineering task.",
  "",
  'Review task "{{taskTitle}}" for concrete correctness issues, regressions, risky edge cases, and missing test coverage.',
  "",
  "{{taskDescriptionBlock}}",
  "",
  "This is a read-only review. Do not edit files, write code, create commits, or change git state.",
  "",
  'Review the current branch against `{{baseRef}}` from worktree branch `{{branchName}}`.',
  "",
  "{{pullRequestUrlLine}}",
  "{{pullRequestTitleLine}}",
  "{{pullRequestReviewDecisionLine}}",
  "{{pullRequestStatusRollupLine}}",
  "{{pullRequestMergeStateLine}}",
  "{{unresolvedConversationCountLine}}",
  "{{changedFilesBlock}}",
  "",
  "Only call out issues when you can tie them to a concrete risk in the current diff or surrounding code.",
  "",
  "Prefer a short list of the most important findings over exhaustive nitpicks.",
  "",
  "Write the human-readable review in {{language}} unless code, identifiers, or error messages are clearer in English.",
  "",
  'End your response with a fenced ```json block containing exactly {"verdict":"approve"|"comment"|"request_changes","summary":"..."} .',
  "",
  'Use "request_changes" when you have any concrete warnings or suggested fixes - even if they are not strictly blocking, the author should address them before merging. Use "comment" only when you have minor stylistic notes or open questions with no clear fix. Use "approve" only when you found no issues worth flagging.',
  "",
  "Keep the JSON summary concise and actionable."
].join("\n");

const DEFAULT_REVIEW_FOLLOW_UP_TEMPLATE = [
  "The AI reviewer requested changes.",
  "",
  "{{reviewFollowUpInstruction}}"
].join("\n");

export const WORKSPACE_PROMPT_TEMPLATE_DEFINITIONS = {
  plan: {
    label: "Plan Prompt",
    description:
      "Used when generating an implementation plan before coding starts.",
    defaultTemplate: DEFAULT_PLAN_TEMPLATE,
    variables: [
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
        key: "workingDirectory",
        token: "{{workingDirectory}}",
        description: "Workspace path used for the run."
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
      }
    ],
    previewValues: {
      taskTitle: "自定义工作区提示词设置",
      taskDescription: "让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。",
      taskDescriptionBlock:
        "Task description:\n让 workspace settings 支持自定义四类 prompt，并提供可视化 preview。",
      workingDirectory: "/Users/you/projects/workhorse",
      baseRef: "origin/main",
      branchName: "task/custom-workspace-prompts"
    }
  },
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
  },
  review: {
    label: "Review Prompt",
    description:
      "Used by the built-in Claude reviewer for manual and automatic review runs.",
    defaultTemplate: DEFAULT_REVIEW_TEMPLATE,
    variables: [
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
        key: "baseRef",
        token: "{{baseRef}}",
        description: "Base branch or ref under review."
      },
      {
        key: "branchName",
        token: "{{branchName}}",
        description: "Worktree branch under review."
      },
      {
        key: "pullRequestUrlLine",
        token: "{{pullRequestUrlLine}}",
        description: "Preformatted GitHub PR URL line when a PR exists."
      },
      {
        key: "pullRequestTitleLine",
        token: "{{pullRequestTitleLine}}",
        description: "Preformatted PR title line when available."
      },
      {
        key: "pullRequestReviewDecisionLine",
        token: "{{pullRequestReviewDecisionLine}}",
        description: "Preformatted current GitHub review decision line."
      },
      {
        key: "pullRequestStatusRollupLine",
        token: "{{pullRequestStatusRollupLine}}",
        description: "Preformatted status rollup line."
      },
      {
        key: "pullRequestMergeStateLine",
        token: "{{pullRequestMergeStateLine}}",
        description: "Preformatted merge-state line."
      },
      {
        key: "unresolvedConversationCountLine",
        token: "{{unresolvedConversationCountLine}}",
        description: "Preformatted unresolved conversation count line."
      },
      {
        key: "changedFilesBlock",
        token: "{{changedFilesBlock}}",
        description: "Preformatted changed files summary block."
      },
      {
        key: "language",
        token: "{{language}}",
        description: "Current global review language."
      }
    ],
    previewValues: {
      taskTitle: "自定义工作区提示词设置",
      taskDescription:
        "让 workspace settings 支持自定义四类 prompt，并提供多 tab 的所见即所得 preview。",
      taskDescriptionBlock:
        "Task description:\n让 workspace settings 支持自定义四类 prompt，并提供多 tab 的所见即所得 preview。",
      baseRef: "origin/main",
      branchName: "task/custom-workspace-prompts",
      pullRequestUrlLine:
        "GitHub PR: https://github.com/acme/workhorse/pull/42",
      pullRequestTitleLine: "PR title: feat: add workspace prompt templates",
      pullRequestReviewDecisionLine:
        "Current GitHub review decision: CHANGES_REQUESTED",
      pullRequestStatusRollupLine:
        "Current PR status rollup: FAILURE",
      pullRequestMergeStateLine: "Merge state: DIRTY",
      unresolvedConversationCountLine: "Unresolved review conversations: 3",
      changedFilesBlock: [
        "Changed files snapshot:",
        "- packages/contracts/src/prompt-template.ts (+180/-0)",
        "- packages/server/src/services/board-service.ts (+42/-8)",
        "- packages/web/src/components/WorkspaceModals.tsx (+220/-55)"
      ].join("\n"),
      language: "中文"
    }
  },
  reviewFollowUp: {
    label: "Review Callback Coding",
    description:
      "Used when the reviewer sends the task back for rework and Coding needs a follow-up instruction.",
    defaultTemplate: DEFAULT_REVIEW_FOLLOW_UP_TEMPLATE,
    variables: [
      {
        key: "taskTitle",
        token: "{{taskTitle}}",
        description: "Current task title."
      },
      {
        key: "reviewSummary",
        token: "{{reviewSummary}}",
        description: "Structured review summary emitted by the reviewer."
      },
      {
        key: "reviewFollowUpInstruction",
        token: "{{reviewFollowUpInstruction}}",
        description:
          "Built-in follow-up instruction with fallback when no structured summary is available."
      },
      {
        key: "reviewRunId",
        token: "{{reviewRunId}}",
        description: "Run id of the review that triggered the rework."
      }
    ],
    previewValues: {
      taskTitle: "自定义工作区提示词设置",
      reviewSummary:
        "Preview panel should show resolved template text, and prompt variables need clearer hints.",
      reviewFollowUpInstruction:
        "Address the following feedback:\n\nPreview panel should show resolved template text, and prompt variables need clearer hints.",
      reviewRunId: "run-review-42"
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
