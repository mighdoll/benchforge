import * as Plot from "@observablehq/plot";

/** Plot data bounds used to position the legend overlay */
export interface LegendBounds {
  xMin: number;
  xMax: number;
  yMax: number;
}

/** A single entry in the plot legend with color, label, and symbol style */
export interface LegendItem {
  color: string;
  label: string;
  style:
    | "filled-dot"
    | "hollow-dot"
    | "vertical-bar"
    | "vertical-line"
    | "rect";
  strokeDash?: string;
}

interface LegendPos {
  legendX: number;
  y: number;
  textX: number;
  xRange: number;
  yMax: number;
}

/** Build complete legend marks array, positioned in the right margin */
export function buildLegend(bounds: LegendBounds, items: LegendItem[]): any[] {
  const xRange = bounds.xMax - bounds.xMin;
  const legendX = bounds.xMax + xRange * 0.04;
  const textX = legendX + xRange * 0.03;
  const itemHeight = bounds.yMax * 0.07;
  const topY = bounds.yMax * 0.98;
  const getY = (i: number) => topY - i * itemHeight;

  const pos = (i: number): LegendPos => ({
    legendX,
    y: getY(i),
    textX,
    xRange,
    yMax: bounds.yMax,
  });
  return items.flatMap((item, i) => [
    symbolMark(pos(i), item),
    textMark(pos(i), item.label),
  ]);
}

/** Dispatch to the appropriate mark builder for a legend item's symbol style */
function symbolMark(pos: LegendPos, item: LegendItem): any {
  switch (item.style) {
    case "filled-dot":
      return dotMark(pos.legendX, pos.y, item.color, true);
    case "hollow-dot":
      return dotMark(pos.legendX, pos.y, item.color, false);
    case "vertical-bar":
      return verticalBarMark(pos, item.color);
    case "vertical-line":
      return verticalLineMark(pos, item.color, item.strokeDash);
    case "rect":
      return rectMark(pos, item.color);
  }
}

function textMark(pos: LegendPos, label: string): any {
  const data = [{ x: pos.textX, y: pos.y, text: label }];
  return Plot.text(data, {
    x: "x",
    y: "y",
    text: "text",
    fontSize: 11,
    textAnchor: "start",
    fill: "#333",
    clip: false,
  });
}

function dotMark(x: number, y: number, color: string, filled: boolean): any {
  return Plot.dot(
    [{ x, y }],
    filled
      ? { x: "x", y: "y", fill: color, r: 4, clip: false }
      : { x: "x", y: "y", stroke: color, fill: "none", strokeWidth: 1.5, r: 4, clip: false },
  );
}

function verticalBarMark(pos: LegendPos, color: string): any {
  const { legendX, y, xRange, yMax } = pos;
  const w = xRange * 0.012;
  const h = yMax * 0.05;
  const x1 = legendX - w / 2;
  const x2 = legendX + w / 2;
  const y1 = y - h / 2;
  const y2 = y + h / 2;
  return Plot.rect([{ x1, x2, y1, y2 }], {
    x1: "x1",
    x2: "x2",
    y1: "y1",
    y2: "y2",
    fill: color,
    fillOpacity: 0.6,
    clip: false,
  });
}

function verticalLineMark(
  pos: LegendPos,
  color: string,
  strokeDash?: string,
): any {
  const { legendX, y, yMax } = pos;
  return Plot.ruleX([legendX], {
    y1: y - yMax * 0.025,
    y2: y + yMax * 0.025,
    stroke: color,
    strokeWidth: 2,
    strokeDasharray: strokeDash,
    clip: false,
  });
}

function rectMark(pos: LegendPos, color: string): any {
  const { legendX, y, xRange, yMax } = pos;
  const x1 = legendX - xRange * 0.01;
  const x2 = legendX + xRange * 0.03;
  const y1 = y - yMax * 0.02;
  const y2 = y + yMax * 0.02;
  return Plot.rect([{ x1, x2, y1, y2 }], {
    x1: "x1",
    x2: "x2",
    y1: "y1",
    y2: "y2",
    fill: color,
    fillOpacity: 0.3,
    stroke: color,
    strokeWidth: 1,
    clip: false,
  });
}
