/** Test cases module with async loadCase */
export const cases = ["alpha", "beta"];

export async function loadCase(id: string) {
  await Promise.resolve(); // simulate async
  return { data: id.toUpperCase(), metadata: { original: id } };
}
