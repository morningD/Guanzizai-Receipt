export type AiBackendWithModels = "api" | "codex" | "opencode";

export type AiModelOption = { value: string; label: string };

export type CachedAiModelLists = Partial<Record<AiBackendWithModels, AiModelOption[]>>;

export const AI_MODEL_CACHE_KEY = "guanzizai-receipt-ai-model-cache:v1";

export function loadCachedAiModels(): CachedAiModelLists {
  try {
    const value = JSON.parse(localStorage.getItem(AI_MODEL_CACHE_KEY) ?? "{}") as CachedAiModelLists;
    return {
      api: Array.isArray(value.api) ? value.api : undefined,
      codex: Array.isArray(value.codex) ? value.codex : undefined,
      opencode: Array.isArray(value.opencode) ? value.opencode : undefined,
    };
  } catch {
    return {};
  }
}

export function saveCachedAiModels(backend: AiBackendWithModels, models: AiModelOption[]) {
  const cache = loadCachedAiModels();
  cache[backend] = models;
  localStorage.setItem(AI_MODEL_CACHE_KEY, JSON.stringify(cache));
}
