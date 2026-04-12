export const setup = (data: unknown): { value: unknown } => ({ value: data });
export const run = (state: { value: unknown }): unknown => state.value;
