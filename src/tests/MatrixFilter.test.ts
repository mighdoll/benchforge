import { expect, test } from "vitest";
import type { BenchMatrix } from "../BenchMatrix.ts";
import { filterMatrix, parseMatrixFilter } from "../matrix/MatrixFilter.ts";

test("parseMatrixFilter: case/variant", () => {
  expect(parseMatrixFilter("bevy/link")).toEqual({
    case: "bevy",
    variant: "link",
  });
});

test("parseMatrixFilter: case/", () => {
  expect(parseMatrixFilter("bevy/")).toEqual({
    case: "bevy",
    variant: undefined,
  });
});

test("parseMatrixFilter: /variant", () => {
  expect(parseMatrixFilter("/link")).toEqual({
    case: undefined,
    variant: "link",
  });
});

test("parseMatrixFilter: case only (no slash)", () => {
  expect(parseMatrixFilter("bevy")).toEqual({ case: "bevy" });
});

test("parseMatrixFilter: empty parts", () => {
  expect(parseMatrixFilter("/")).toEqual({
    case: undefined,
    variant: undefined,
  });
});

const inlineMatrix: BenchMatrix<string> = {
  name: "Test",
  variants: {
    fast: (s: string) => s.toUpperCase(),
    slow: (s: string) => s.toLowerCase(),
    medium: (s: string) => s,
  },
  cases: ["small", "large", "bevy_env_map"],
};

test("filterMatrix: no filter returns original", async () => {
  const result = await filterMatrix(inlineMatrix, undefined);
  expect(result).toBe(inlineMatrix);
});

test("filterMatrix: case filter only", async () => {
  const result = await filterMatrix(inlineMatrix, { case: "bevy" });
  expect(result.filteredCases).toEqual(["bevy_env_map"]);
  expect(result.filteredVariants).toBeUndefined();
});

test("filterMatrix: variant filter only", async () => {
  const result = await filterMatrix(inlineMatrix, { variant: "fast" });
  expect(result.filteredVariants).toEqual(["fast"]);
  expect(result.filteredCases).toBeUndefined();
});

test("filterMatrix: case and variant filter", async () => {
  const result = await filterMatrix(inlineMatrix, {
    case: "small",
    variant: "slow",
  });
  expect(result.filteredCases).toEqual(["small"]);
  expect(result.filteredVariants).toEqual(["slow"]);
});

test("filterMatrix: case-insensitive matching", async () => {
  const result = await filterMatrix(inlineMatrix, {
    case: "SMALL",
    variant: "FAST",
  });
  expect(result.filteredCases).toEqual(["small"]);
  expect(result.filteredVariants).toEqual(["fast"]);
});

test("filterMatrix: substring matching", async () => {
  const result = await filterMatrix(inlineMatrix, { case: "env" });
  expect(result.filteredCases).toEqual(["bevy_env_map"]);
});

test("filterMatrix: no matching cases throws", async () => {
  await expect(
    filterMatrix(inlineMatrix, { case: "nonexistent" }),
  ).rejects.toThrow('No cases match filter: "nonexistent"');
});

test("filterMatrix: no matching variants throws", async () => {
  await expect(
    filterMatrix(inlineMatrix, { variant: "nonexistent" }),
  ).rejects.toThrow('No variants match filter: "nonexistent"');
});

test("filterMatrix: multiple matching cases", async () => {
  const result = await filterMatrix(inlineMatrix, { case: "l" }); // matches small, large
  expect(result.filteredCases).toEqual(["small", "large"]);
});

test("filterMatrix: multiple matching variants", async () => {
  const result = await filterMatrix(inlineMatrix, { variant: "s" }); // matches fast, slow
  expect(result.filteredVariants?.sort()).toEqual(["fast", "slow"]);
});

const noExplicitCases: BenchMatrix = {
  name: "NoCase",
  variants: { fast: () => {} },
};

test("filterMatrix: implicit default case returns default", async () => {
  const result = await filterMatrix(noExplicitCases, { case: "default" });
  expect(result.filteredCases).toEqual(["default"]);
});
