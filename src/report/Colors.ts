import pico from "picocolors";
import type { Colors } from "picocolors/types";

const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

/** Picocolors instance that disables color in test environments */
const colors: Colors = pico.createColors(!isTest);

export default colors;
