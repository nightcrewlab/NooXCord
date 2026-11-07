import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { create } from "zustand";
import type { VoiceState } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useVoice, voice } from "../../media/engine";
import { useVoiceSettings } from "../../media/settings";
import { useStore } from "../../state/store";
import s from "./voice.module.css";

/** Is this user speaking right now? Self uses the local detector (no network delay). */
export function useIsSpeaking(channelId: string, userId: string): boolean {
  const meId = useStore((st) => st.me?.id);
  const server = useStore((st) => !!st.speaking[channelId]?.includes(userId));
  const local = useVoice((v) => v.selfSpeaking && v.channelId === channelId);
  return userId === meId ? local : server;
}

/** Voice states of one channel, oldest joiner first. */
export function useChannelVoice(guildId: string, channelId: string): VoiceState[] {
  const list = useStore((st) => st.guilds[guildId]?.voice);
  return (list ?? []).filter((v) => v.channelId === channelId).sort((a, b) => a.joinedAt - b.joinedAt);
}

export function LiveBadge() {
  return <span className={s.live}>{t("stream.live")}</span>;
}

/** <video> bound to a MediaStream. */
export function StreamVideo({ stream, muted, volume }: { stream: MediaStream; muted: boolean; volume: number }) {
  const ref = useRef<HTMLVideoElement>(null);
  const tracks = stream.getTracks().length;
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => {});
  }, [stream, tracks]);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.muted = muted;
    ref.current.volume = Math.max(0, Math.min(1, volume));
  }, [muted, volume]);
  return <video ref={ref} autoPlay playsInline muted={muted} />;
}

/** Small popover with a volume slider for one user (or one stream: key "stream:<id>"). */
export function VolumePopover({ x, y, userId, name, onClose }: { x: number; y: number; userId: string; name: string; onClose: () => void }) {
  const vol = useVoiceSettings((st) => st.volumes[userId] ?? 1);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); };
  }, [onClose]);
  const left = Math.min(x, window.innerWidth - 232);
  const top = Math.min(y, window.innerHeight - 90);
  return createPortal(
    <div className={s.pop} ref={ref} style={{ left, top }} role="dialog" aria-label={t("voice.volume")}>
      <div className={s.popHead}><span>{t("voice.volume")} · {name}</span><span>{Math.round(vol * 100)}%</span></div>
      <input type="range" min={0} max={100} step={1} value={Math.round(vol * 100)} onChange={(e) => voice.setUserVolume(userId, Number(e.target.value) / 100)} autoFocus />
    </div>,
    document.body,
  );
}

export function useVolumePopover() {
  const [pop, setPop] = useState<{ x: number; y: number; userId: string; name: string } | null>(null);
  const node = pop ? <VolumePopover {...pop} onClose={() => setPop(null)} /> : null;
  return { open: (e: React.MouseEvent, userId: string, name: string) => { e.preventDefault(); setPop({ x: e.clientX, y: e.clientY, userId, name }); }, node };
}

/** Whether the screen share picker is open (opened from several places). */
export const useShareModal = create<{ open: boolean }>()(() => ({ open: false }));
export const openShareModal = () => useShareModal.setState({ open: true });
