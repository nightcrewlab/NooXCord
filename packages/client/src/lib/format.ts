import { t } from "../i18n";

const timeFmt = new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" });
const dateFmt = new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("tr-TR", { dateStyle: "full", timeStyle: "short" });

const dayStart = (ts: number) => new Date(ts).setHours(0, 0, 0, 0);

export function formatTime(ts: number): string {
  return timeFmt.format(ts);
}

export function formatFull(ts: number): string {
  return fullFmt.format(ts);
}

/** "Bugün 14:05", "Dün 09:12" or "3 Kasım 2026 14:05". */
export function formatStamp(ts: number): string {
  const d = dayStart(ts);
  const today = dayStart(Date.now());
  if (d === today) return `${t("chat.today")} ${formatTime(ts)}`;
  if (d === today - 86_400_000) return `${t("chat.yesterday")} ${formatTime(ts)}`;
  return `${dateFmt.format(ts)} ${formatTime(ts)}`;
}

export function formatDay(ts: number): string {
  const d = dayStart(ts);
  const today = dayStart(Date.now());
  if (d === today) return t("chat.today");
  if (d === today - 86_400_000) return t("chat.yesterday");
  return dateFmt.format(ts);
}

export const sameDay = (a: number, b: number) => dayStart(a) === dayStart(b);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Stable accent colour per user for avatar fallbacks. */
const PALETTE = ["#FF7A45", "#FFB347", "#3DDC84", "#4CC9F0", "#B388FF", "#FF5C8A", "#5CE1E6", "#F5C451"];
export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toLocaleUpperCase("tr");
}
