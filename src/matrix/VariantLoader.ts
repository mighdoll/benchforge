import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Variant } from "../BenchMatrix.ts";

/** Discover variant ids from a directory of .ts files */
export async function discoverVariants(dirUrl: string): Promise<string[]> {
  const dirPath = fileURLToPath(dirUrl);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter(e => e.isFile() && e.name.endsWith(".ts"))
    .map(e => e.name.slice(0, -3))
    .sort();
}

/** Load a variant module and extract run/setup exports */
export async function loadVariant<T = unknown>(
  dirUrl: string,
  variantId: string,
): Promise<Variant<T>> {
  const moduleUrl = variantModuleUrl(dirUrl, variantId);
  const module = await import(moduleUrl);
  return extractVariant(module, variantId, moduleUrl);
}

/** Extract variant from module exports */
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

/** Get module URL for a variant in a directory */
export function variantModuleUrl(dirUrl: string, variantId: string): string {
  return new URL(`${variantId}.ts`, dirUrl).href;
}
