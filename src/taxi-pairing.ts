import type { ReceiptRecord, Requirement, RequirementGroup } from "./types";

const TAXI_REQUIREMENT_IDS = new Set(["taxi-note", "intercity-taxi-invoice", "intercity-taxi-itinerary"]);

function hasMatchingFile(records: ReceiptRecord[], requirement: Requirement) {
  return records.some((record) => {
    const value = `${record.name} ${record.path}`.toLowerCase();
    const matches = requirement.keywords.map((keyword) => value.includes(keyword.toLowerCase()));
    return requirement.matchAll ? matches.every(Boolean) : matches.some(Boolean);
  });
}

function matchingRecords(records: ReceiptRecord[], requirement: Requirement) {
  return records.filter((record) => {
    const value = `${record.name} ${record.path}`.toLowerCase();
    const matches = requirement.keywords.map((keyword) => value.includes(keyword.toLowerCase()));
    return requirement.matchAll ? matches.every(Boolean) : matches.some(Boolean);
  });
}

function recordDate(record: ReceiptRecord) {
  return record.invoiceDate || record.name.match(/\d{4}-\d{2}-\d{2}/)?.[0] || "";
}

export function activateIntercityTaxiSet(group: RequirementGroup, records: ReceiptRecord[]): RequirementGroup {
  const taxiRequirements = group.requirements.filter((requirement) => TAXI_REQUIREMENT_IDS.has(requirement.id));
  const active = taxiRequirements.some((requirement) => hasMatchingFile(records, requirement));
  if (!active) {
    return {
      ...group,
      requirements: group.requirements.filter((requirement) => !TAXI_REQUIREMENT_IDS.has(requirement.id)),
    };
  }
  const invoiceRequirement = taxiRequirements.find((requirement) => requirement.id === "intercity-taxi-invoice");
  const itineraryRequirement = taxiRequirements.find((requirement) => requirement.id === "intercity-taxi-itinerary");
  const invoices = invoiceRequirement ? matchingRecords(records, invoiceRequirement) : [];
  const itineraries = itineraryRequirement ? matchingRecords(records, itineraryRequirement) : [];
  const remainingItineraries = [...itineraries];
  const paired: Array<{ invoice: ReceiptRecord; itinerary: ReceiptRecord }> = [];
  const unpairedInvoices: ReceiptRecord[] = [];
  for (const invoice of invoices) {
    const date = recordDate(invoice);
    const index = remainingItineraries.findIndex((itinerary) => date && recordDate(itinerary) === date);
    if (index < 0) unpairedInvoices.push(invoice);
    else paired.push({ invoice, itinerary: remainingItineraries.splice(index, 1)[0] });
  }
  const noteRequirement = taxiRequirements.find((requirement) => requirement.id === "taxi-note");
  const hasTaxiNote = noteRequirement ? hasMatchingFile(records, noteRequirement) : false;
  const generatedRequirements: Requirement[] = [
    ...(noteRequirement ? [{ ...noteRequirement, optional: false }] : []),
    ...paired.map(({ invoice, itinerary }) => ({ id: `taxi-pair-${invoice.path}`, label: "打车发票与行程单", hint: `${invoice.name} ↔ ${itinerary.name}`, keywords: [], requiredPaths: [invoice.path, itinerary.path] })),
    ...unpairedInvoices.map((invoice) => ({ id: `taxi-itinerary-missing-${invoice.path}`, label: "补充打车行程单", hint: `${invoice.name} 未找到同日行程单`, keywords: [] })),
    ...remainingItineraries.map((itinerary) => ({ id: `taxi-invoice-missing-${itinerary.path}`, label: "补充打车发票", hint: `${itinerary.name} 未找到同日打车发票`, keywords: [] })),
    ...(hasTaxiNote && !invoices.length ? [{ id: "taxi-invoice-missing", label: "补充打车发票", hint: "跨城市打车说明已识别，请补充对应发票", keywords: [] }] : []),
    ...(hasTaxiNote && !itineraries.length ? [{ id: "taxi-itinerary-missing", label: "补充打车行程单", hint: "跨城市打车说明已识别，请补充对应行程单", keywords: [] }] : []),
  ];
  return {
    ...group,
    optional: false,
    hint: "已识别跨城市打车材料，请补齐说明、打车发票与行程单",
    requirements: [...group.requirements.filter((requirement) => !TAXI_REQUIREMENT_IDS.has(requirement.id)), ...generatedRequirements],
  };
}
