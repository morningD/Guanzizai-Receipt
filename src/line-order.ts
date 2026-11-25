import type { ExpenseLine } from "./types";

export function orderLinesForView(lines: ExpenseLine[], view: ExpenseLine["status"]) {
  const matchingLines = lines.filter((line) => line.status === view);
  if (view === "archived") return [...matchingLines].sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  if (view === "submitted") {
    // 已递交按递交时间新到旧（submittedAt 缺失回退 createdAt）；入账状态由卡片徽章表达，不参与排序。
    const submittedTime = (line: ExpenseLine) => line.submittedAt || line.createdAt;
    return [...matchingLines].sort((first, second) => submittedTime(second).localeCompare(submittedTime(first)));
  }
  return matchingLines;
}
