import { type ThemePreference, themePreference } from "./State.ts";

function applyTheme(pref: ThemePreference): void {
  const el = document.documentElement;
  if (pref === "system") {
    delete el.dataset.theme;
    // biome-ignore lint/suspicious/noDocumentCookie: no alternative API for setting cookies
    document.cookie = "theme=; max-age=0; path=/; SameSite=Lax";
  } else {
    el.dataset.theme = pref;
    // biome-ignore lint/suspicious/noDocumentCookie: no alternative API for setting cookies
    document.cookie = `theme=${pref}; max-age=31536000; path=/; SameSite=Lax`;
  }
}

export function setTheme(pref: ThemePreference): void {
  themePreference.value = pref;
  applyTheme(pref);
}
