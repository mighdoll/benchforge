/** Escape a string for safe insertion into HTML. */
export function escapeHtml(s: string): string {
  const el = document.createElement("div");
  el.textContent = s;
  return el.innerHTML;
}

/** Cached reference to the `.tab-bar` element. */
export const tabBar = document.querySelector(".tab-bar") as HTMLDivElement;

/** Cached reference to the `.tab-content` element. */
export const tabContent = document.querySelector(
  ".tab-content",
) as HTMLDivElement;

/** Infer a Shiki language id from a file extension. */
export function guessLang(file: string): string {
  if (file.endsWith(".ts") || file.endsWith(".tsx")) return "typescript";
  if (file.endsWith(".css")) return "css";
  if (file.endsWith(".html")) return "html";
  return "javascript";
}

/** Extract the pathname from a URL, returning the input unchanged if it isn't a valid URL. */
export function filePathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
