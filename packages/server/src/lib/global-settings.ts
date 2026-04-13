import type { GlobalSettings } from "@workhorse/contracts";
import {
  DEFAULT_GLOBAL_LANGUAGE,
  DEFAULT_OPENROUTER_BASE_URL
} from "@workhorse/contracts";

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  language: DEFAULT_GLOBAL_LANGUAGE,
  openRouter: {
    baseUrl: DEFAULT_OPENROUTER_BASE_URL,
    token: "",
    model: ""
  }
};

export function resolveGlobalSettings(
  settings:
    | Partial<GlobalSettings>
    | {
        language?: string | undefined;
        openRouter?: Partial<GlobalSettings["openRouter"]> | undefined;
        scheduler?: { maxConcurrent?: number | undefined } | undefined;
      }
    | undefined
): GlobalSettings {
  const language = settings?.language?.trim();
  const baseUrl = settings?.openRouter?.baseUrl?.trim();
  const maxConcurrent = settings?.scheduler?.maxConcurrent;

  return {
    language: language || DEFAULT_GLOBAL_SETTINGS.language,
    openRouter: {
      baseUrl: baseUrl || DEFAULT_GLOBAL_SETTINGS.openRouter.baseUrl,
      token: settings?.openRouter?.token?.trim() ?? "",
      model: settings?.openRouter?.model?.trim() ?? ""
    },
    // maxConcurrent=0 is a valid value that disables automatic task scheduling;
    // preserve it explicitly so tests and configs can pause the scheduler.
    ...(maxConcurrent !== undefined && maxConcurrent >= 0
      ? { scheduler: { maxConcurrent } }
      : {})
  };
}

export function hasOpenRouterConfig(settings: GlobalSettings): boolean {
  return Boolean(
    settings.openRouter.baseUrl.trim() &&
      settings.openRouter.token.trim() &&
      settings.openRouter.model.trim()
  );
}
