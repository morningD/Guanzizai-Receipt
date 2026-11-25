import type { TraceLevel } from "./trace";

export const developerLogLevels = ["debug", "info", "warn", "error", "off"] as const;
export type DeveloperLogSettings = {
  level: TraceLevel | "off";
  maxMiB: number;
};

export const defaultDeveloperLogSettings: DeveloperLogSettings = { level: "debug", maxMiB: 32 };

export function parseDeveloperLogSettings(value: unknown): DeveloperLogSettings | null {
  if (!value || typeof value !== "object") return null;
  const { level, maxMiB } = value as Partial<DeveloperLogSettings>;
  if (level === undefined || !developerLogLevels.includes(level)
    || typeof maxMiB !== "number" || !Number.isInteger(maxMiB) || maxMiB < 1 || maxMiB > 256) return null;
  return { level, maxMiB };
}
