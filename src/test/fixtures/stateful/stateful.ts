export const setup = (data: unknown) => ({ value: data });
export const run = (state: { value: unknown }) => state.value;
