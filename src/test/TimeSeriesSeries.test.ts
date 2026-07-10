import { expect, test } from "vitest";
import { gcSeriesLabel } from "../viewer/plots/TimeSeriesSeries.ts";

test("gcSeriesLabel uses a plain label for a lone current variant", () => {
  expect(gcSeriesLabel("link", false, false)).toBe("full GC");
});

test("gcSeriesLabel suffixes the baseline series", () => {
  // the (baseline) suffix comes from the flag, not from the passed name
  expect(gcSeriesLabel("link", true, false)).toBe("full GC (baseline)");
});

test("gcSeriesLabel names current variants when several carry GC marks", () => {
  expect(gcSeriesLabel("link", false, true)).toBe("full GC (link)");
});
