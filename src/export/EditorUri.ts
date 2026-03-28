const presets: Record<string, string> = {
  vscode: "vscode://file",
  cursor: "cursor://file",
};

/** Resolve editor name or custom URI to a prefix.
 *  Links are formatted as `{prefix}{absolutePath}:{line}:{col}` */
export function resolveEditorUri(editor: string): string {
  return presets[editor] ?? editor;
}
