import en from "./en.json";
import tr from "./tr.json";

export type I18nKey = keyof typeof tr;
export type Lang = "tr" | "en";

const DICTS: Record<Lang, Record<string, string>> = { tr, en };
const KEY = "nx.lang";

function initial(): Lang {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "tr" || v === "en") return v;
  } catch { /* storage blocked */ }
  return "tr"; // default language (CLAUDE.md §0)
}

let lang: Lang = initial();
let dict = DICTS[lang];
if (typeof document !== "undefined") document.documentElement.lang = lang;

export const getLang = (): Lang => lang;

/** Switches language; the caller reloads the UI (strings are read at render time). */
export function setLang(l: Lang): void {
  lang = l;
  dict = DICTS[l];
  try { localStorage.setItem(KEY, l); } catch { /* storage blocked */ }
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

/** Translate with {placeholder} substitution; falls back to Turkish, then the key. */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? DICTS.tr[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}
