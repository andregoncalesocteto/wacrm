// ============================================================
// Stability label of the public API contract, shown on every /developers page.
//
// The events API is pre-stable until the first client integrates (the pilot);
// after that it is frozen and a breaking change needs `v2`. When the pilot has
// integrated, change this ONE value to 'stable' in a PR. The matching texts
// are Developers.statusPreStable / Developers.statusStable in the catalogues.
// ============================================================

export type ContractStatus = 'pre-stable' | 'stable';

export const CONTRACT_STATUS: ContractStatus = 'pre-stable';

/** Message key (inside the `Developers` namespace) for a status. */
export const CONTRACT_STATUS_MESSAGE_KEY = {
  'pre-stable': 'statusPreStable',
  stable: 'statusStable',
} as const satisfies Record<ContractStatus, string>;
