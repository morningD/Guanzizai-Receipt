import type { ExpenseLine, ReceiptRecord, ViewId } from "./types";

const root = "01_报销材料/";
function folderStatus(filePath: string): ViewId | undefined {
  if (filePath.startsWith(`${root}90_已归档/`)) return "archived";
  if (filePath.startsWith(`${root}30_已提交/`)) return "submitted";
  if (filePath.startsWith(`${root}10_办理中/`) || filePath.startsWith(`${root}20_待提交/`)) return "active";
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function materialSearchTerms(query: string) {
  return normalize(query).trim().split(/\s+/).filter(Boolean);
}

export function materialSearchHighlights(text: string, terms: readonly string[]) {
  const normalized = normalize(text);
  const matches = terms.flatMap((term) => {
    if (!term) return [];
    const ranges = [];
    for (let start = normalized.indexOf(term); start !== -1; start = normalized.indexOf(term, start + 1)) {
      ranges.push({ start, end: start + term.length });
    }
    return ranges;
  }).sort((a, b) => a.start - b.start);
  if (!matches.length) return [{ text, matched: false }];

  // Keep original spelling even when Unicode normalization changes a character's length.
  const ranges: Array<{ start: number; end: number; matched: boolean }> = [];
  let offset = 0;
  let matchIndex = 0;
  for (const { segment, index } of graphemes.segment(text)) {
    const end = offset + normalize(segment).length;
    while (matches[matchIndex] && matches[matchIndex].end <= offset) matchIndex++;
    const match = matches[matchIndex];
    const matched = Boolean(match && match.start < end);
    const previous = ranges.at(-1);
    if (previous?.matched === matched) previous.end = index + segment.length;
    else ranges.push({ start: index, end: index + segment.length, matched });
    offset = end;
  }
  return ranges.map(({ start, end, matched }) => ({ text: text.slice(start, end), matched }));
}

export function searchMaterials(records: readonly ReceiptRecord[], lines: readonly ExpenseLine[], scopes: readonly ViewId[], query: string) {
  const terms = materialSearchTerms(query);
  if (!terms.length || !scopes.length) return [];
  const orderedLines = lines.filter((line) => line.folder).sort((a, b) => b.folder.length - a.folder.length);
  const results = [];
  for (const file of records) {
    const line = orderedLines.find((entry) => file.path.startsWith(`${entry.folder}/`));
    const status = line?.status ?? folderStatus(file.path);
    if (!status || !scopes.includes(status)) continue;
    const name = normalize(file.name);
    const searchable = normalize([file.name, file.path, line?.title, file.issuer, file.invoiceDate, file.note, file.category, file.expenseClassification].join(" "));
    if (terms.every((term) => searchable.includes(term))) {
      const visible = normalize([file.name, line?.title || file.folder.split("/").at(-1), file.issuer].join(" "));
      const details = [file.invoiceDate, file.note, file.category, file.expenseClassification, file.folder];
      const matchingDetails = [...new Set(terms
        .filter((term) => !visible.includes(term))
        .map((term) => details.find((value) => value && normalize(value).includes(term)))
        .filter(Boolean))];
      results.push({ file, status, lineTitle: line?.title, matchingDetails, nameMatch: terms.every((term) => name.includes(term)) });
    }
  }
  return results.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.file.modifiedAt.localeCompare(a.file.modifiedAt));
}
