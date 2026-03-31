import { createApiClient as createSharedApiClient } from "@workhorse/api-client";

const baseUrl = import.meta.env.VITE_API_BASE_URL ?? "";

export const api = createSharedApiClient(baseUrl);

export const createApiClient = createSharedApiClient;

export type ApiClient = ReturnType<typeof createSharedApiClient>;
