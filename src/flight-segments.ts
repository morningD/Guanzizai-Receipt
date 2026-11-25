import { validPaymentDate } from "./cloud-payment";
import type { FlightSegment } from "./types";

const city = (value: unknown) => typeof value === "string" && /^[\p{L}][\p{L} .'-]{1,29}$/u.test(value.trim())
  ? value.trim().replace(/\s+/g, "").replace(/市$/, "")
    .replace(/^上海(?:虹桥|浦东)(?:国际)?(?:机场)?$/, "上海")
    .replace(/^北京(?:首都|大兴)(?:国际)?(?:机场)?$/, "北京").toUpperCase()
  : undefined;
const flight = (value: unknown) => {
  const normalized = typeof value === "string" ? value.toUpperCase().replace(/\s+/g, "") : "";
  return /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/.test(normalized) ? normalized : undefined;
};

export function normalizeFlightSegments(value: unknown): FlightSegment[] | undefined {
  if (!Array.isArray(value)) return;
  const segments = value.slice(0, 8).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { from: rawFrom, to: rawTo, travelDate: rawDate, flightNumber: rawFlight } = entry;
    const from = city(rawFrom);
    const to = city(rawTo);
    const travelDate = validPaymentDate(rawDate);
    const flightNumber = flight(rawFlight);
    const route = from && to && from !== to ? { from, to } : {};
    return (from && to && from !== to) || (travelDate && flightNumber) ? [{ ...route, travelDate, flightNumber }] : [];
  });
  return segments.length ? segments : undefined;
}

/** 从有「自」「至」和航班栏的电子客票提取出行日，忽略填开日期。 */
export function flightSegmentsFromText(text: string) {
  const normalized = text.normalize("NFKC");
  if (!normalized.includes("航班号")) return;
  const rows = [...normalized.matchAll(/^\s*自:\s*([\p{Script=Han}]{2,12})\s+[^\n]*?\b([A-Z0-9]{2}\d{1,4}[A-Z]?)\s+[^\n]*?(\d{4})年(\d{1,2})月(\d{1,2})日[^\n]*\n(?:[^\S\n]*\n)*[^\S\n]*至:\s*([\p{Script=Han}]{2,12})/gmu)];
  return normalizeFlightSegments(rows.map(([, from, flightNumber, year, month, date, to]) =>
    ({ from, to, flightNumber, travelDate: `${year}-${month.padStart(2, "0")}-${date.padStart(2, "0")}` })));
}

/** 2 为同航班同出行日，1 为同方向且无航班或日期冲突。 */
export function flightSegmentMatch(a: FlightSegment, b: FlightSegment) {
  const sameRoute = Boolean(a.from && a.to && a.from === b.from && a.to === b.to);
  if ((a.from && a.to && b.from && b.to && !sameRoute)
    || (a.flightNumber && b.flightNumber && a.flightNumber !== b.flightNumber)
    || (a.travelDate && b.travelDate && a.travelDate !== b.travelDate)) return 0;
  if (a.flightNumber && a.flightNumber === b.flightNumber && a.travelDate && a.travelDate === b.travelDate) return 2;
  return sameRoute ? 1 : 0;
}

/** 改签可能换航班、日期、机场。只检查资料中明确给出的城市方向。 */
export function rebookingRoutesCompatible(before: unknown, after: unknown) {
  const routes = (value: unknown) => normalizeFlightSegments(value)?.filter((leg) => leg.from && leg.to) ?? [];
  const a = routes(before);
  const b = routes(after);
  return !a.length || !b.length || a.some((leg) => b.some((other) => leg.from === other.from && leg.to === other.to));
}
