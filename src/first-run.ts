import type { LineDelivery } from "./types";

export type FirstRunConfig = {
  dataRoot: string;
  completed: boolean;
  delivery: LineDelivery;
};

export const emptyDelivery: LineDelivery = { campus: "", approver: "", printByFinance: false };

export function normalizeFirstRunInput(value: unknown) {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const field = (key: string) => typeof body[key] === "string" ? body[key].trim().slice(0, 120) : "";
  const campus = body.campus === "普陀校区" || body.campus === "闵行校区" ? body.campus : "";
  const delivery: LineDelivery = { campus, approver: field("approver"), printByFinance: body.printByFinance === true };
  return { chineseName: field("chineseName"), organization: field("organization"), delivery };
}
