import * as Plot from "@observablehq/plot";

export interface LegendBounds {
  xMin: number;
  xMax: number;
  yMax: number;
}

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

/** Draw a semi-transparent white background behind the legend area */
function legendBackground(bounds: LegendBounds): any {
  const xRange = bounds.xMax - bounds.xMin;
  const data = [
    {
      x1: bounds.xMin + xRange * 0.65,
      x2: bounds.xMin + xRange * 1.05,
      y1: bounds.yMax * 0.65,
      y2: bounds.yMax * 1.05,
    },
  ];
  const opts = {
    x1: "x1",
    x2: "x2",
    y1: "y1",
    y2: "y2",
    fill: "white",
    fillOpacity: 0.9,
    stroke: "#ddd",
    strokeWidth: 1,
  };
  return Plot.rect(data, opts);
}

function dotMark(x: number, y: number, color: string, filled: boolean): any {
  return Plot.dot(
    [{ x, y }],
    filled
      ? { x: "x", y: "y", fill: color, r: 4 }
      : { x: "x", y: "y", stroke: color, fill: "none", strokeWidth: 1.5, r: 4 },
  );
}

function verticalBarMark(pos: LegendPos, color: string): any {
  const { legendX, y, xRange, yMax } = pos;
  const w = xRange * 0.012;
  const h = yMax * 0.05;
  const data = [
    { x1: legendX - w / 2, x2: legendX + w / 2, y1: y - h / 2, y2: y + h / 2 },
  ];
  return Plot.rect(data, {
    x1: "x1",
    x2: "x2",
    y1: "y1",
    y2: "y2",
    fill: color,
    fillOpacity: 0.6,
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
  });
}

function rectMark(pos: LegendPos, color: string): any {
  const { legendX, y, xRange, yMax } = pos;
  const data = [
    {
      x1: legendX - xRange * 0.01,
      x2: legendX + xRange * 0.03,
      y1: y - yMax * 0.02,
      y2: y + yMax * 0.02,
    },
  ];
  const opts = {
    x1: "x1",
    x2: "x2",
    y1: "y1",
    y2: "y2",
    fill: color,
    fillOpacity: 0.3,
    stroke: color,
    strokeWidth: 1,
  };
  return Plot.rect(data, opts);
}

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
  });
}

/** Build complete legend marks array */
export function buildLegend(bounds: LegendBounds, items: LegendItem[]): any[] {
  const xRange = bounds.xMax - bounds.xMin;
  const legendX = bounds.xMin + xRange * 0.68;
  const textX = legendX + xRange * 0.04;
  const getY = (i: number) => bounds.yMax * 0.98 - i * (bounds.yMax * 0.08);

  const marks: any[] = [legendBackground(bounds)];
  for (let i = 0; i < items.length; i++) {
    const pos: LegendPos = {
      legendX,
      y: getY(i),
      textX,
      xRange,
      yMax: bounds.yMax,
    };
    marks.push(symbolMark(pos, items[i]), textMark(pos, items[i].label));
  }
  return marks;
}
