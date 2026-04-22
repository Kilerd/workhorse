import type { TaskDependenciesResponse } from "@workhorse/contracts";
import { createApiClient as createSharedApiClient } from "@workhorse/api-client";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

function resolveRequestUrl(base: string, path: string): string {
  if (!base) {
    return path;
  }

  return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(resolveRequestUrl(baseUrl, path), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  const payload = (await response.json()) as T;
  if (!response.ok) {
    throw Object.assign(new Error(response.statusText), {
      data: payload,
      status: response.status
    });
  }
  return payload;
}

function unwrap<T>(response: { ok: true; data: T }): T {
  return response.data;
}

const sharedClient = createSharedApiClient(baseUrl);

export const api = {
  ...sharedClient,
  getTask: async (taskId: string) =>
    unwrap(
      await requestJson<TaskDependenciesResponse>(
        `/api/tasks/${encodeURIComponent(taskId)}/dependencies`
      )
    )
};

export const createApiClient = createSharedApiClient;

export type ApiClient = ReturnType<typeof createSharedApiClient>;
