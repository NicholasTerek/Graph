// Shared identifiers for the eight assumptions returned by launch-readiness v1.
export const launchAssumptionRules = [
  { id: "launch.synthetic.v1", types: [] },
  { id: "launch.inventory.v1", types: ["Product", "Component", "Supplier"] },
  {
    id: "launch.sequence.v1",
    types: ["Component", "Supplier", "Issue", "Release"],
  },
  {
    id: "launch.validation.v1",
    types: ["Product", "Release", "Test"],
  },
  {
    id: "launch.eligibility.v1",
    types: ["Product", "Supplier", "Release"],
  },
  { id: "launch.rank.v1", types: ["Product", "Supplier", "Release"] },
  { id: "launch.capacity-reservation.v1", types: ["Product", "Supplier"] },
  { id: "launch.validation-prediction.v1", types: ["Test"] },
] as const;
