import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Variant } from "./BenchMatrix.ts";

/** List variant IDs by scanning .ts files in a directory */
export async function discoverVariants(dirUrl: string): Promise<string[]> {
  const dirPath = fileURLToPath(dirUrl);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".ts"))
    .map(e => e.name.slice(0, -3))
    .sort();
}

/** Import a variant module and return its run/setup exports as a Variant */
export async function loadVariant<T = unknown>(
  dirUrl: string,
  variantId: string,
): Promise<Variant<T>> {
  const moduleUrl = variantModuleUrl(dirUrl, variantId);
  const module = await import(moduleUrl);
  return extractVariant(module, variantId, moduleUrl);
}

/** Resolve the import URL for a variant file */
export function variantModuleUrl(dirUrl: string, variantId: string): string {
  return new URL(`${variantId}.ts`, dirUrl).href;
}

/** Validate and extract a Variant from a module's exports */
function extractVariant<T>(
  module: Record<string, unknown>,
  variantId: string,
  moduleUrl: string,
): Variant<T> {
  const { setup, run } = module;
  const loc = `Variant '${variantId}' at ${moduleUrl}`;
  if (typeof run !== "function") {
    throw new Error(`${loc} must export 'run'`);
  }
  if (setup === undefined) return run as (data: T) => void;
  if (typeof setup !== "function") {
    throw new Error(`${loc}: 'setup' must be a function`);
  }
  return { setup: setup as (data: T) => unknown, run: run as () => void };
}
