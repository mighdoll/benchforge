export const svgNS = "http://www.w3.org/2000/svg";

const toKebab = (k: string) => k.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
const svgEl = (tag: string) => document.createElementNS(svgNS, tag);

/** Apply camelCase attributes to an SVG element, converting to kebab-case */
export function setAttrs(el: SVGElement, attrs: Record<string, string>): void {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(toKebab(k), v);
}

/** Create an SVG root element with viewBox. */
export function createSvg(w: number, h: number): SVGSVGElement {
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  return svg;
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  attrs: Record<string, string>,
): SVGRectElement {
  const el = document.createElementNS(svgNS, "rect");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("width", String(w));
  el.setAttribute("height", String(h));
  setAttrs(el, attrs);
  return el;
}

export function line(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  attrs: Record<string, string>,
): SVGLineElement {
  const el = document.createElementNS(svgNS, "line");
  el.setAttribute("x1", String(x1));
  el.setAttribute("y1", String(y1));
  el.setAttribute("x2", String(x2));
  el.setAttribute("y2", String(y2));
  setAttrs(el, attrs);
  return el;
}

export function text(
  x: number,
  y: number,
  content: string,
  anchor = "start",
  size = "9",
  fill = "#666",
  weight = "400",
): SVGTextElement {
  const el = document.createElementNS(svgNS, "text");
  el.setAttribute("x", String(x));
  el.setAttribute("y", String(y));
  el.setAttribute("text-anchor", anchor);
  el.setAttribute("font-size", size);
  el.setAttribute("font-weight", weight);
  el.setAttribute("fill", fill);
  el.textContent = content;
  return el;
}

export function path(d: string, attrs: Record<string, string>): SVGPathElement {
  const el = document.createElementNS(svgNS, "path");
  el.setAttribute("d", d);
  setAttrs(el, attrs);
  return el;
}

/** Add a turbulence displacement filter for a sketchy/wobbly look */
export function ensureSketchFilter(svg: SVGSVGElement): string {
  const id = "ci-sketch";
  if (svg.querySelector(`#${id}`)) return id;
  const defs = ensureDefs(svg);
  const filter = svgEl("filter");
  setAttrs(filter, { id, x: "-5%", y: "-5%", width: "110%", height: "110%" });
  const turb = svgEl("feTurbulence");
  setAttrs(turb, {
    type: "turbulence",
    baseFrequency: "0.06",
    numOctaves: "4",
    seed: "1",
    result: "noise",
  });
  const disp = svgEl("feDisplacementMap");
  setAttrs(disp, {
    in: "SourceGraphic",
    in2: "noise",
    scale: "10",
    xChannelSelector: "R",
    yChannelSelector: "G",
  });
  filter.appendChild(turb);
  filter.appendChild(disp);
  defs.appendChild(filter);
  return id;
}

/** Add a diagonal hatch pattern to the SVG defs, reusing if already present */
export function ensureHatchPattern(svg: SVGSVGElement): string {
  const id = "margin-hatch";
  if (svg.querySelector(`#${id}`)) return id;
  const defs = ensureDefs(svg);
  const pattern = svgEl("pattern");
  setAttrs(pattern, {
    id,
    patternUnits: "userSpaceOnUse",
    width: "5",
    height: "5",
    patternTransform: "rotate(45)",
  });
  const stripe = svgEl("line");
  setAttrs(stripe, { x1: "0", y1: "0", x2: "0", y2: "5" });
  stripe.classList.add("margin-hatch-stroke");
  pattern.appendChild(stripe);
  defs.appendChild(pattern);
  return id;
}

function ensureDefs(svg: SVGSVGElement): SVGDefsElement {
  let defs = svg.querySelector("defs") as SVGDefsElement | null;
  if (!defs) {
    defs = document.createElementNS(svgNS, "defs") as SVGDefsElement;
    svg.insertBefore(defs, svg.firstChild);
  }
  return defs;
}
