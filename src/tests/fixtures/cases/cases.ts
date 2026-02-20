/** Test cases module for Phase 3 testing */
export const cases = ["small", "large"];

export function loadCase(id: string) {
  const data =
    id === "small" ? [1, 2, 3] : Array.from({ length: 100 }, (_, i) => i);
  return { data, metadata: { size: data.length } };
}
