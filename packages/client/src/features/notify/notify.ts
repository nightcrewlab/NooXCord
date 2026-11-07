import { create } from "zustand";
import type { EventName, Events, Message } from "@nooxcord/shared";
import { t } from "../../i18n";
import type { HostConnection } from "../../net/connection";
import { platform } from "../../platform";
import { DM_HOME, useStore } from "../../state/store";

/*
 * Desktop notifications (CLAUDE.md §12.3): direct messages and @mentions, unless the status is
 * "do not disturb", the channel is muted, or you are already looking at that channel.
 * Uses the HTML Notification API (Windows toasts in Electron; browsers after permission).
 */

interface NotifyPrefs {
  enabled: boolean;
  sound: boolean;
  /** Channel ids (guild channels or DMs) whose notifications are off. */
  muted: string[];
}

const KEY = "nx.notify";
function load(): NotifyPrefs {
  const d: NotifyPrefs = { enabled: true, sound: true, muted: [] };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<NotifyPrefs>) }; } catch { return d; }
}

export const useNotify = create<NotifyPrefs & { set(p: Partial<NotifyPrefs>): void; toggleChannel(id: string): void }>()((set, get) => ({
  ...load(),
  set(p) {
    set(p);
    const { enabled, sound, muted } = get();
    try { localStorage.setItem(KEY, JSON.stringify({ enabled, sound, muted })); } catch { /* storage blocked */ }
  },
  toggleChannel(id) {
    const m = get().muted;
    get().set({ muted: m.includes(id) ? m.filter((x) => x !== id) : [...m, id] });
  },
}));

/** Does this text mention the nickname as @nickname (case-insensitive, whole word)? */
export function mentions(content: string, nickname: string): boolean {
  const esc = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}_])@${esc}(?![\\p{L}\\p{N}_])`, "iu").test(content);
}

export const notificationsSupported = (): boolean => typeof Notification !== "undefined";

/** Browsers need a permission prompt (from a click); Electron grants it. */
export async function ensurePermission(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

let ctx: AudioContext | null = null;
function ping() {
  try {
    ctx ??= new AudioContext();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.26);
  } catch { /* audio unavailable */ }
}

function onMessage(m: Message): void {
  const st = useStore.getState();
  const me = st.me;
  const prefs = useNotify.getState();
  if (!me || m.authorId === me.id || !prefs.enabled || me.status === "dnd" || prefs.muted.includes(m.channelId)) return;
  const dm = st.dms[m.channelId];
  const guild = dm ? undefined : Object.values(st.guilds).find((g) => g.channels.some((c) => c.id === m.channelId));
  const channel = guild?.channels.find((c) => c.id === m.channelId);
  if (!dm && !(channel && mentions(m.content, me.nickname))) return;
  const gid = dm ? DM_HOME : guild!.guild.id;
  const looking = document.hasFocus() && st.selectedGuild === gid && st.selectedChannel[gid] === m.channelId;
  if (looking) return;
  void platform.app?.attention();
  if (prefs.sound) ping();
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  const author = st.users[m.authorId];
  const body = (m.content || t("notify.attachment")).slice(0, 180);
  const title = dm ? author?.nickname ?? "NooXCord" : `${author?.nickname ?? "?"} · ${t("notify.inChannel", { channel: channel!.name, guild: guild!.guild.name })}`;
  const icon = author?.avatar ? st.http?.url(author.avatar) ?? undefined : undefined;
  const n = new Notification(title, { body, icon, tag: m.channelId, silent: true });
  n.onclick = () => {
    void platform.app?.focus();
    window.focus();
    useStore.getState().selectChannel(gid, m.channelId);
    window.dispatchEvent(new CustomEvent("nx:channel-open", { detail: "text" }));
    n.close();
  };
}

let bound: HostConnection | null = null;
let off: (() => void) | null = null;

/** Follows the active host connection; call once at startup. */
export function initNotifications(): void {
  const bind = (conn: HostConnection | null) => {
    if (conn === bound) return;
    off?.();
    off = null;
    bound = conn;
    if (conn) off = conn.on(<E extends EventName>(e: E, d: Events[E]) => e === "message.create" && onMessage(d as Message));
  };
  bind(useStore.getState().conn);
  useStore.subscribe((s) => bind(s.conn));
}
