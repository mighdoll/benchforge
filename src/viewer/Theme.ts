import { type ThemePreference, themePreference } from "./State.ts";

/** Apply a theme preference, persisting to a cookie and updating the document. */
export function setTheme(pref: ThemePreference): void {
  themePreference.value = pref;
  if (pref === "system") {
    delete document.documentElement.dataset.theme;
    // biome-ignore lint/suspicious/noDocumentCookie: no alternative API for setting cookies
    document.cookie = "theme=; max-age=0; path=/; SameSite=Lax";
  } else {
    document.documentElement.dataset.theme = pref;
    // biome-ignore lint/suspicious/noDocumentCookie: no alternative API for setting cookies
    document.cookie = `theme=${pref}; max-age=31536000; path=/; SameSite=Lax`;
  }
}
