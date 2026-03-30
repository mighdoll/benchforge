/** Test cases module with async loadCase */
export const cases: string[] = ["alpha", "beta"];

export async function loadCase(
  id: string,
): Promise<{ data: string; metadata: { original: string } }> {
  await Promise.resolve(); // simulate async
  return { data: id.toUpperCase(), metadata: { original: id } };
}
