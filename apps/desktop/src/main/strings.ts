import en from "../../../../packages/client/src/i18n/en.json";
import tr from "../../../../packages/client/src/i18n/tr.json";

/*
 * Main-process text (tray, notifications, errors) comes from the client's i18n files, bundled at
 * build time, so nothing user-visible is hard-coded here. The language follows the renderer setting.
 */
export type Lang = "tr" | "en";
export type StringKey = keyof typeof tr;

const dicts: Record<Lang, Record<string, string>> = { tr, en };
let lang: Lang = "tr";

export const setLang = (l: unknown): void => {
  if (l === "tr" || l === "en") lang = l;
};
export const getLang = (): Lang => lang;

export function s(key: StringKey, vars?: Record<string, string | number>): string {
  const v = dicts[lang][key] ?? dicts.tr[key] ?? key;
  return vars ? v.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : v;
}
