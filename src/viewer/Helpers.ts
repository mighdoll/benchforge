/** Escape a string for safe insertion into HTML. */
export function escapeHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

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
