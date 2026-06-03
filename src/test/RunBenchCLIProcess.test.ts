import { execSync } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";

// Subprocess CLI tests live apart from the in-process RunBenchCLI tests so the
// two run on separate vitest workers (tests within one file run serially).
// These spawn the real CLI (default worker mode), covering the full process path.

/** Execute test fixture script and return output */
function executeTestScript(args = ""): string {
  const script = path.join(
    import.meta.dirname!,
    "fixtures/test-bench-script.ts",
  );
  return execSync(`node --expose-gc --allow-natives-syntax ${script} ${args}`, {
    encoding: "utf8",
  });
}

/** Run a fixture file via bin/benchforge and return output */
function executeBenchforgeFile(file: string, args = ""): string {
  const bin = path.join(import.meta.dirname!, "../../bin/benchforge");
  const fixture = path.join(import.meta.dirname!, "fixtures", file);
  return execSync(`${bin} ${fixture} ${args}`, { encoding: "utf8" });
}

test("e2e: runs user script", { timeout: 30000 }, () => {
  const output = executeTestScript("--duration 0.1");

  expect(output).toContain("plus");
  expect(output).toContain("multiply");
  expect(output).toContain("(mean)");

  const lines = output.split("\n");
  const plusLine = lines.find(l => l.includes("plus"));
  expect(plusLine).toBeTruthy();
});

test("e2e: filter flag", { timeout: 30000 }, () => {
  const output = executeTestScript('--filter "plus" --duration 0.1');

  expect(output).toContain("plus");
  expect(output).not.toContain("multiply");
});

test("file mode: BenchSuite export", { timeout: 30000 }, () => {
  const output = executeBenchforgeFile(
    "suite-export-bench.ts",
    "--iterations 5",
  );

  expect(output).toContain("plus");
  expect(output).toContain("multiply");
  expect(output).toContain("(mean)");
});

test("file mode: function export", { timeout: 30000 }, () => {
  const output = executeBenchforgeFile("fn-export-bench.ts", "--iterations 5");

  expect(output).toContain("fn-export-bench");
  expect(output).toContain("(mean)");
});
