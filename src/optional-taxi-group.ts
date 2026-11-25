import type { RequirementGroup } from "./types";

export function appendOptionalTaxiGroup(source: RequirementGroup, expanded: RequirementGroup) {
  const taxiNote = source.requirements.find((requirement) => requirement.id === "taxi-note");
  const hasActiveTaxiSet = expanded.requirements.some((requirement) => requirement.id === "taxi-note");
  if (source.id !== "transport" || !taxiNote || hasActiveTaxiSet) return [expanded];
  return [
    expanded,
    {
      id: "intercity-taxi-optional",
      label: "跨城市打车",
      hint: "如实际发生，可先编写说明；上传发票或行程单后自动核对成套材料",
      requirements: [{ ...taxiNote, optional: false }],
      optional: true,
    },
  ];
}
