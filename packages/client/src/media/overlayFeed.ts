import { platform, type OverlayMember } from "../platform";
import { useStore } from "../state/store";
import { useVoice } from "./engine";
import { useVoiceSettings } from "./settings";

/** Pushes the current voice channel to the desktop overlay window (no-op in the browser). */
export function startOverlayFeed(): void {
  const overlay = platform.overlay;
  if (!overlay) return;
  let last = "";
  const push = () => {
    const v = useVoice.getState();
    const st = useStore.getState();
    let list: OverlayMember[] | null = null;
    if (v.channelId && v.guildId && useVoiceSettings.getState().overlay) {
      const states = (st.guilds[v.guildId]?.voice ?? []).filter((x) => x.channelId === v.channelId).sort((a, b) => a.joinedAt - b.joinedAt);
      const speaking = st.speaking[v.channelId] ?? [];
      list = states.map((x) => {
        const u = st.users[x.userId];
        const self = x.userId === st.me?.id;
        return {
          id: x.userId,
          name: u?.nickname ?? "?",
          avatar: st.http?.url(u?.avatar) ?? null,
          self,
          speaking: self ? v.selfSpeaking : speaking.includes(x.userId),
          muted: x.muted || x.suppressed,
          deafened: x.deafened,
          live: !!x.stream,
        };
      });
    }
    const key = JSON.stringify(list);
    if (key === last) return;
    last = key;
    overlay.update(list);
  };
  useStore.subscribe(push);
  useVoice.subscribe(push);
  useVoiceSettings.subscribe(push);
}
