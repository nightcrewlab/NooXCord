/*
 * Voice channel cues: someone joins / leaves my voice channel, mutes / unmutes, deafens / undeafens
 * (me included). Short synthesized tones on the shared playback AudioContext — no audio files.
 */
import { audioContext } from "../../media/level";
import { useVoice } from "../../media/engine";
import { voiceSettings } from "../../media/settings";
import { useStore } from "../../state/store";

type Cue = "join" | "leave" | "mute" | "unmute" | "deafen" | "undeafen";

/** [frequency Hz, start s, length s] notes per cue. Rising = on/in, falling = off/out. */
const NOTES: Record<Cue, [number, number, number][]> = {
  join: [[587, 0, 0.11], [880, 0.09, 0.16]],
  leave: [[880, 0, 0.11], [523, 0.09, 0.18]],
  mute: [[494, 0, 0.07], [370, 0.06, 0.09]],
  unmute: [[370, 0, 0.07], [494, 0.06, 0.09]],
  deafen: [[392, 0, 0.08], [294, 0.07, 0.08], [220, 0.14, 0.11]],
  undeafen: [[220, 0, 0.08], [294, 0.07, 0.08], [392, 0.14, 0.11]],
};

const lastPlayed = new Map<Cue, number>();

export function playCue(cue: Cue): void {
  if (!voiceSettings().voiceSounds) return;
  const now = performance.now();
  if (now - (lastPlayed.get(cue) ?? 0) < 150) return; // a burst of events → one cue
  lastPlayed.set(cue, now);
  try {
    const c = audioContext();
    const t0 = c.currentTime + 0.01;
    const out = c.createGain();
    out.gain.value = 0.09;
    out.connect(c.destination);
    for (const [f, at, len] of NOTES[cue]) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = "triangle";
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + at);
      g.gain.exponentialRampToValueAtTime(1, t0 + at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len);
      o.connect(g).connect(out);
      o.start(t0 + at);
      o.stop(t0 + at + len + 0.02);
    }
    const end = Math.max(...NOTES[cue].map(([, at, len]) => at + len)) + 0.1;
    window.setTimeout(() => out.disconnect(), end * 1000);
  } catch { /* audio unavailable */ }
}

interface Member { muted: boolean; deafened: boolean }

let started = false;

export function initVoiceSounds(): void {
  if (started) return;
  started = true;
  let members: Map<string, Member> | null = null; // my channel's others; null = not in voice
  let channel: string | null = null;
  const pendingLeave = new Map<string, number>();

  const snapshot = (): Map<string, Member> => {
    const st = useStore.getState();
    const v = useVoice.getState();
    const me = st.me?.id;
    const out = new Map<string, Member>();
    const g = v.guildId ? st.guilds[v.guildId] : undefined;
    for (const x of g?.voice ?? []) {
      if (x.channelId === v.channelId && x.userId !== me) out.set(x.userId, { muted: x.muted || x.suppressed, deafened: x.deafened });
    }
    return out;
  };

  const diff = () => {
    const v = useVoice.getState();
    if (v.status !== "connected" || !v.channelId) return;
    const now = snapshot();
    if (!members || channel !== v.channelId) {
      members = now; // fresh baseline (joined, switched or reconnected): no cues for who was already there
      channel = v.channelId;
      return;
    }
    for (const [id, m] of now) {
      const before = members.get(id);
      if (!before) {
        // Back within a moment (their reconnect): neither a leave nor a join cue.
        const p = pendingLeave.get(id);
        if (p) { clearTimeout(p); pendingLeave.delete(id); } else playCue("join");
        continue;
      }
      if (before.deafened !== m.deafened) playCue(m.deafened ? "deafen" : "undeafen");
      else if (before.muted !== m.muted) playCue(m.muted ? "mute" : "unmute");
    }
    for (const id of members.keys()) {
      if (now.has(id) || pendingLeave.has(id)) continue;
      pendingLeave.set(id, window.setTimeout(() => {
        pendingLeave.delete(id);
        if (useVoice.getState().channelId === channel) playCue("leave");
      }, 1500));
    }
    members = now;
  };

  useVoice.subscribe((v, prev) => {
    // Me: join / leave / mute / deafen.
    if (v.status === "connected" && prev.status === "connecting") playCue("join");
    if (v.status === "idle" && prev.status !== "idle" && prev.channelId) playCue("leave");
    if (v.channelId && v.status !== "idle" && prev.status !== "idle") {
      if (v.deafened !== prev.deafened) playCue(v.deafened ? "deafen" : "undeafen");
      else if (v.muted !== prev.muted) playCue(v.muted ? "mute" : "unmute");
    }
    if (v.status !== "connected" || v.channelId !== prev.channelId) {
      // Reconnecting / left / switched: start over once connected again.
      if (v.status !== "connected") members = null;
      for (const p of pendingLeave.values()) clearTimeout(p);
      pendingLeave.clear();
    }
    diff();
  });
  useStore.subscribe((st, prev) => {
    if (st.guilds !== prev.guilds) diff();
  });
}
