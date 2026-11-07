import tr from "./tr.json";

export type I18nKey = keyof typeof tr;
const dict: Record<string, string> = tr;

/** Translate with {placeholder} substitution. English (en.json) arrives in Faz 4. */
export function t(key: I18nKey, vars?: Record<string, string | number>): string {
  const s = dict[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}
