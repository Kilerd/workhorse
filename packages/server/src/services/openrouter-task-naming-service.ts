import type { GlobalSettings } from "@workhorse/contracts";

import { AppError } from "../lib/errors.js";
import { hasOpenRouterConfig } from "../lib/global-settings.js";

export interface GeneratedTaskIdentity {
  title: string;
  worktreeName: string;
}

export interface TaskIdentityGenerator {
  generate(input: {
    description: string;
    settings: GlobalSettings;
  }): Promise<GeneratedTaskIdentity>;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: OpenRouterMessageContent;
    };
  }>;
  error?: {
    message?: string;
  };
}

type OpenRouterMessageContent =
  | string
  | Array<{
      type?: string;
      text?: string;
    }>;

function toChatCompletionsUrl(baseUrl: string): string {
  return new URL("chat/completions", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function extractMessageText(content: OpenRouterMessageContent | undefined): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .join("\n")
    .trim();
}

function extractJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new AppError(
      502,
      "AI_TITLE_GENERATION_FAILED",
      "OpenRouter did not return valid task metadata"
    );
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new AppError(
      502,
      "AI_TITLE_GENERATION_FAILED",
      "OpenRouter returned invalid JSON for task metadata"
    );
  }
}

function normalizeWorktreeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "task"
  );
}

export class OpenRouterTaskIdentityGenerator implements TaskIdentityGenerator {
  public async generate(input: {
    description: string;
    settings: GlobalSettings;
  }): Promise<GeneratedTaskIdentity> {
    const description = input.description.trim();
    if (!description) {
      throw new AppError(
        400,
        "INVALID_TASK",
        "Task title or description is required"
      );
    }

    if (!hasOpenRouterConfig(input.settings)) {
      throw new AppError(
        400,
        "AI_SETTINGS_INCOMPLETE",
        "Configure OpenRouter base URL, token, and model in global settings before using AI title generation"
      );
    }

    let response: Response;
    try {
      response = await fetch(toChatCompletionsUrl(input.settings.openRouter.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.settings.openRouter.token}`,
          "x-title": "Workhorse"
        },
        body: JSON.stringify({
          model: input.settings.openRouter.model,
          temperature: 0.2,
          response_format: {
            type: "json_object"
          },
          messages: [
            {
              role: "system",
              content:
                'You generate concise engineering task metadata. Return JSON only with keys "title" and "worktreeName". ' +
                "The title must be short, natural, and written in the requested language. " +
                "The worktreeName must be lowercase ASCII kebab-case for a git branch/worktree segment without any prefix."
            },
            {
              role: "user",
              content:
                `Language: ${input.settings.language}\n` +
                "Create a simple task title and worktree name for this task description.\n" +
                `Description:\n${description}`
            }
          ]
        })
      });
    } catch (error) {
      throw new AppError(
        502,
        "AI_TITLE_GENERATION_FAILED",
        error instanceof Error
          ? `OpenRouter request failed: ${error.message}`
          : "OpenRouter request failed"
      );
    }

    const responseText = await response.text();
    let payload: OpenRouterResponse | undefined;
    if (responseText.trim()) {
      try {
        payload = JSON.parse(responseText) as OpenRouterResponse;
      } catch {
        if (!response.ok) {
          throw new AppError(
            502,
            "AI_TITLE_GENERATION_FAILED",
            `OpenRouter request failed with status ${response.status}`
          );
        }
      }
    }

    if (!response.ok) {
      const errorMessage = payload?.error?.message?.trim();
      throw new AppError(
        502,
        "AI_TITLE_GENERATION_FAILED",
        errorMessage ||
          `OpenRouter request failed with status ${response.status}`
      );
    }

    const content = extractMessageText(payload?.choices?.[0]?.message?.content);
    const parsed = extractJsonObject(content);
    const title =
      typeof parsed.title === "string" ? parsed.title.trim() : "";
    const worktreeRaw =
      typeof parsed.worktreeName === "string"
        ? parsed.worktreeName
        : typeof parsed.worktree_name === "string"
          ? parsed.worktree_name
          : title;

    if (!title) {
      throw new AppError(
        502,
        "AI_TITLE_GENERATION_FAILED",
        "OpenRouter did not return a task title"
      );
    }

    return {
      title,
      worktreeName: normalizeWorktreeName(worktreeRaw)
    };
  }
}
