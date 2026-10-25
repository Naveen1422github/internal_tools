// file: core/src/sync/compat.ts
// Schema guard policy: the post office accepts a laptop on the same schema, or on an
// older one the office explicitly lists. A future migration adds its peers here.
export const WIRE_COMPAT: Readonly<Record<string, readonly string[]>> = {};

export function schemaCompatible(
  office: string,
  device: string,
  table: Readonly<Record<string, readonly string[]>> = WIRE_COMPAT,
): boolean {
  return office === device || table[office]?.includes(device) === true;
}
