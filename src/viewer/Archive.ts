import type { DataProvider } from "./Providers.ts";

/** Download a `.benchforge` archive via the provider and trigger a browser save. */
export async function archiveProfile(provider: DataProvider): Promise<void> {
  const sel = '[data-action="archive"]';
  const btn = document.querySelector(sel) as HTMLButtonElement;
  const originalText = btn.textContent;
  btn.textContent = "Archiving\u2026";
  btn.disabled = true;

  try {
    const { blob, filename } = await provider.createArchive();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  } catch (err) {
    console.error("Archive failed:", err);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}
