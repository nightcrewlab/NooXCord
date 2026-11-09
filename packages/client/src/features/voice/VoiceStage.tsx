import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "@nooxcord/icons";
import { P, has, type Channel, type VoiceState } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useVoice, voice, type WatchedStream } from "../../media/engine";
import { remote, remoteCapable, useRemote } from "../../media/remote";
import { useVoiceSettings } from "../../media/settings";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { Avatar, Button, IconButton, Spinner, cx, useMenu } from "../../ui";
import { RemoteSurface } from "../remote/Remote";
import chat from "../chat/chat.module.css";
import layout from "../layout/layout.module.css";
import { CallTimer, LiveBadge, StreamVideo, useChannelVoice, useIsSpeaking, useVolumePopover } from "./common";
import s from "./voice.module.css";

/** Main area for a voice channel: streams on top, participants below, call controls at the bottom. */
export function VoiceStage({ guildId, channel, onShare }: { guildId: string; channel: Channel; onShare: () => void }) {
  const states = useChannelVoice(guildId, channel.id);
  const myPerms = useStore((st) => st.guilds[guildId]?.myPerms ?? 0);
  const showMembers = useStore((st) => st.showMembers);
  const toggleMembers = useStore((st) => st.toggleMembers);
  const meId = useStore((st) => st.me?.id);
  const v = useVoice(useShallow((x) => ({ channelId: x.channelId, status: x.status, watching: x.watching, focus: x.focus, sharing: x.sharing })));
  const otherChannel = useStore((st) => (v.channelId && v.channelId !== channel.id ? Object.values(st.guilds).flatMap((g) => g.channels).find((c) => c.id === v.channelId) : undefined));
  const pop = useVolumePopover();
  const here = v.channelId === channel.id;
  const canJoin = has(myPerms, P.CONNECT_VOICE);

  const streams = states.filter((x) => x.stream);
  const watchedIds = Object.keys(v.watching).filter((id) => streams.some((x) => x.userId === id));
  const unwatched = streams.filter((x) => !(x.userId in v.watching));
  // Theater: a watched stream fills the stage, everyone else sits in a strip under it (CLAUDE.md §6.4).
  const theater = here && watchedIds.length > 0;

  return (
    <main className={layout.card}>
      <header className={chat.head}>
        <Icon name="speaker" size={22} />
        <span className={chat.headName}>{channel.name}</span>
        <CallTimer guildId={guildId} channelId={channel.id} />
        <span style={{ flex: 1 }} />
        {!theater && <IconButton icon="users" label={t("members.toggle")} aria-pressed={showMembers} onClick={toggleMembers} />}
      </header>

      {!here ? (
        <div className={s.stage}>
          <div className={s.join}>
            <div className={s.joinIcon}><Icon name="speaker" size={34} /></div>
            <h2 className={s.joinTitle}>{channel.name}</h2>
            {states.length > 0 ? (
              <div className={s.joinFaces}>{states.slice(0, 8).map((x) => <JoinFace key={x.userId} userId={x.userId} />)}</div>
            ) : (
              <p className={s.joinDesc}>{t("voice.empty")}</p>
            )}
            <p className={s.joinDesc}>{otherChannel ? t("voice.otherChannel", { channel: otherChannel.name }) : t("voice.joinDesc")}</p>
            <Button variant="primary" icon="speaker" disabled={!canJoin} onClick={() => void voice.join(guildId, channel.id)}>
              {otherChannel ? t("voice.switch") : t("voice.join")}
            </Button>
          </div>
        </div>
      ) : theater ? (
        <div className={cx(s.stage, s.theater)}>
          <div className={s.theaterMain}>
            <WatchArea ids={watchedIds} focus={v.focus} states={states} />
          </div>
          {v.sharing && meId && <OwnStreamBar state={states.find((x) => x.userId === meId)} />}
          <ParticipantStrip states={states.filter((x) => !watchedIds.includes(x.userId))} meId={meId} onVolume={pop.open} />
          <CallControls guildId={guildId} onShare={onShare} />
          {pop.node}
        </div>
      ) : (
        <div className={s.stage}>
          <div className={s.stageScroll}>

            {(unwatched.length > 0 || v.sharing) && (
              <section>
                <div className={s.sectionTitle}>{t("stream.live")}</div>
                <div className={s.cards}>
                  {v.sharing && meId && <OwnStreamCard state={states.find((x) => x.userId === meId)} />}
                  {unwatched.filter((x) => x.userId !== meId).map((x) => <StreamCard key={x.userId} state={x} />)}
                </div>
              </section>
            )}

            <section>
              <div className={s.sectionTitle}>{t("voice.participants", { n: states.length })}</div>
              <div className={s.people}>
                {states.map((x) => <Person key={x.userId} state={x} onVolume={pop.open} isMe={x.userId === meId} />)}
              </div>
            </section>
          </div>
          <CallControls guildId={guildId} onShare={onShare} />
          {pop.node}
        </div>
      )}
    </main>
  );
}

/** Theater view while I stream too: my viewers (right-click: remote control) and the tunnel quality. */
function OwnStreamBar({ state }: { state: VoiceState | undefined }) {
  const st = state?.stream;
  if (!st) return null;
  return (
    <div className={s.ownBar}>
      <LiveBadge />
      <span className={s.ownBarText}>{t("stream.yours")} · {t("stream.viewers", { n: st.viewers.length })}</span>
      {st.viewers.length > 0 && <ViewerList viewers={st.viewers} controllerId={st.controllerId} />}
      <span style={{ flex: 1 }} />
      <button className={s.tunnelQ} style={{ margin: 0 }} title={t("stream.tunnelQualityDesc")} onClick={() => void voice.setTunnelQuality(!st.tunnelHigh).catch((e: Error) => useStore.getState().toast(e.message, "error"))}>
        <Icon name="tunnel" size={14} />
        {t("stream.tunnelQuality")}: <b>{st.tunnelHigh ? t("stream.tunnelHigh") : t("stream.tunnelLow")}</b>
      </button>
      <Button variant="danger" size="small" icon="screen-stop" onClick={() => void voice.stopScreen()}>{t("stream.stop")}</Button>
    </div>
  );
}

/** Theater view: people in the channel (cameras small, speaking ring), collapsible with a small handle. */
function ParticipantStrip({ states, meId, onVolume }: { states: VoiceState[]; meId: string | undefined; onVolume: (e: React.MouseEvent, id: string, name: string) => void }) {
  const hidden = useVoiceSettings((x) => x.stripHidden);
  const toggle = () => useVoiceSettings.getState().set({ stripHidden: !hidden });
  return (
    <div className={cx(s.strip, hidden && s.stripHidden)}>
      <button className={s.stripHandle} onClick={toggle} aria-expanded={!hidden} title={hidden ? t("voice.stripShow") : t("voice.stripHide")} aria-label={hidden ? t("voice.stripShow") : t("voice.stripHide")}>
        <Icon name={hidden ? "chevron-up" : "chevron-down"} size={16} />
        {hidden && <span>{t("voice.participants", { n: states.length })}</span>}
      </button>
      {!hidden && states.length > 0 && (
        <div className={s.stripRow}>
          {states.map((x) => <StripPerson key={x.userId} state={x} isMe={x.userId === meId} onVolume={onVolume} />)}
        </div>
      )}
    </div>
  );
}

function StripPerson({ state, isMe, onVolume }: { state: VoiceState; isMe: boolean; onVolume: (e: React.MouseEvent, id: string, name: string) => void }) {
  const user = useStore((st) => st.users[state.userId]);
  const http = useStore((st) => st.http);
  const speaking = useIsSpeaking(state.channelId, state.userId);
  const remoteCam = useVoice((x) => (isMe ? undefined : x.cams[state.userId]));
  const myCam = useVoice((x) => (isMe ? x.camera : null));
  if (!user) return null;
  const cam = isMe ? (myCam ? voice.localCamera() : null) : remoteCam ?? null;
  const live = !!state.stream && !isMe;
  const thumb = live ? http?.url(state.stream!.thumbnail) : undefined;
  const name = `${user.nickname}${isMe ? ` (${t("voice.you")})` : ""}`;
  return (
    <div
      className={cx(s.stripItem, (cam || live) && s.stripCam, speaking && s.speaking, live && s.tileClickable)}
      title={live ? `${name} · ${t("stream.watch")}` : name}
      onClick={() => live && void voice.watch(state.userId)}
      onContextMenu={(e) => !isMe && onVolume(e, user.id, user.nickname)}
    >
      {live ? (
        <>
          <span className={s.stripThumb} style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>{!thumb && <Icon name="monitor" size={24} />}</span>
          <span className={s.stripWatch}><Icon name="eye" size={18} />{t("stream.watch")}</span>
        </>
      ) : cam ? <CamVideo stream={cam} mirror={isMe && myCam?.facing === "user"} /> : <span className={cx(s.ring, speaking && s.ringOn)}><Avatar user={user} size={48} /></span>}
      <span className={s.stripIcons}>
        {(state.muted || state.suppressed) && <Icon name="mic-off" size={14} label={t("voice.mute")} />}
        {state.deafened && <Icon name="headphones-off" size={14} label={t("voice.deafen")} />}
      </span>
      {state.stream && <span className={s.stripLive}><LiveBadge /></span>}
      <span className={s.stripName}>{name}</span>
    </div>
  );
}

function JoinFace({ userId }: { userId: string }) {
  const user = useStore((st) => st.users[userId]);
  return user ? <span><Avatar user={user} size={36} /></span> : null;
}

function Person({ state, onVolume, isMe }: { state: VoiceState; onVolume: (e: React.MouseEvent, id: string, name: string) => void; isMe: boolean }) {
  const user = useStore((st) => st.users[state.userId]);
  const speaking = useIsSpeaking(state.channelId, state.userId);
  const remoteCam = useVoice((x) => (isMe ? undefined : x.cams[state.userId]));
  const myCam = useVoice((x) => (isMe ? x.camera : null));
  const [big, setBig] = useState(false);
  if (!user) return null;
  const cam = isMe ? (myCam ? voice.localCamera() : null) : remoteCam ?? null;
  if (cam) {
    return (
      <div className={cx(s.person, s.personCam, big && s.personCamBig, speaking && s.speaking)} title={t("voice.cameraBig")}
        onClick={() => setBig(!big)} onContextMenu={(e) => !isMe && onVolume(e, user.id, user.nickname)}>
        <CamVideo stream={cam} mirror={isMe && myCam?.facing === "user"} />
        <span className={s.personIcons}>
          {(state.muted || state.suppressed) && <Icon name="mic-off" size={16} label={state.suppressed ? t("voice.suppressed") : t("voice.mute")} />}
          {state.deafened && <Icon name="headphones-off" size={16} label={t("voice.deafen")} />}
        </span>
        <div className={s.personName}>
          <span>{user.nickname}{isMe ? ` (${t("voice.you")})` : ""}</span>
          {state.stream && <LiveBadge />}
        </div>
      </div>
    );
  }
  return (
    <div className={cx(s.person, speaking && s.speaking)} onContextMenu={(e) => !isMe && onVolume(e, user.id, user.nickname)}>
      <span className={s.personIcons}>
        {(state.muted || state.suppressed) && <Icon name="mic-off" size={16} label={state.suppressed ? t("voice.suppressed") : t("voice.mute")} />}
        {state.deafened && <Icon name="headphones-off" size={16} label={t("voice.deafen")} />}
      </span>
      <span className={cx(s.ring, speaking && s.ringOn)}><Avatar user={user} size={64} /></span>
      <div className={s.personName}>
        <span>{user.nickname}{isMe ? ` (${t("voice.you")})` : ""}</span>
        {state.stream && <LiveBadge />}
      </div>
    </div>
  );
}

/** Camera video: no audio, fills its tile; the self view is mirrored like a mirror. */
function CamVideo({ stream, mirror }: { stream: MediaStream; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) v.srcObject = stream;
    void v.play().catch(() => {});
  }, [stream]);
  return <video ref={ref} className={cx(s.camVideo, mirror && s.mirror)} autoPlay playsInline muted />;
}

function qualityLabel(st: { width: number; height: number; fps: number }) {
  return `${Math.min(st.width, st.height)}p${st.fps}`;
}

function StreamCard({ state }: { state: VoiceState }) {
  const user = useStore((st) => st.users[state.userId]);
  const http = useStore((st) => st.http);
  const stream = state.stream!;
  const thumb = http?.url(stream.thumbnail);
  return (
    <div className={s.card}>
      <div className={s.cardThumb} style={thumb ? { backgroundImage: `url("${thumb}")` } : undefined}>
        {!thumb && <Icon name="monitor" size={36} />}
        <LiveBadge />
        <span className={s.cardQuality}>{qualityLabel(stream)}</span>
        <div className={s.cardWatch}>
          <Button variant="primary" icon="eye" onClick={() => void voice.watch(state.userId)}>{t("stream.watch")}</Button>
        </div>
      </div>
      <div className={s.cardBody}>
        {user && <Avatar user={user} size={32} />}
        <div className={s.cardMeta}>
          <div className={s.cardName}>{user?.nickname}</div>
          <div className={s.cardSub}><Icon name="eye" size={13} />{t("stream.viewers", { n: stream.viewers.length })}{stream.audio && <><span>·</span><Icon name="volume" size={13} /></>}</div>
        </div>
        <Button variant="secondary" size="small" onClick={() => void voice.watch(state.userId)}>{t("stream.watch")}</Button>
      </div>
    </div>
  );
}

function OwnStreamCard({ state }: { state: VoiceState | undefined }) {
  const sharing = useVoice((x) => x.sharing)!;
  const local = voice.localScreen();
  return (
    <div className={s.card}>
      <div className={s.cardThumb}>
        {local ? <div className={s.tile} style={{ position: "absolute", inset: 0, border: 0, borderRadius: 0 }}><StreamVideo stream={local} muted volume={0} /></div> : <Icon name="monitor" size={36} />}
        <LiveBadge />
        <span className={s.cardQuality}>{qualityLabel(sharing)}</span>
      </div>
      <div className={s.cardBody}>
        <div className={s.cardMeta}>
          <div className={s.cardName}>{t("stream.yours")}</div>
          <div className={s.cardSub}><Icon name="eye" size={13} />{t("stream.viewers", { n: state?.stream?.viewers.length ?? 0 })}</div>
        </div>
        <Button variant="danger" size="small" icon="screen-stop" onClick={() => void voice.stopScreen()}>{t("stream.stop")}</Button>
      </div>
      {state?.stream && (
        <button className={s.tunnelQ} title={t("stream.tunnelQualityDesc")} onClick={() => void voice.setTunnelQuality(!state.stream!.tunnelHigh).catch((e: Error) => useStore.getState().toast(e.message, "error"))}>
          <Icon name="tunnel" size={14} />
          {t("stream.tunnelQuality")}: <b>{state.stream.tunnelHigh ? t("stream.tunnelHigh") : t("stream.tunnelLow")}</b>
        </button>
      )}
      {!!state?.stream?.viewers.length && <ViewerList viewers={state.stream.viewers} controllerId={state.stream.controllerId} />}
    </div>
  );
}

/** Streamer's viewers; right-click (or click) one to give or take back remote control. */
function ViewerList({ viewers, controllerId }: { viewers: string[]; controllerId: string | null }) {
  const users = useStore((st) => st.users);
  const openMenu = useMenu();
  const capable = remoteCapable();
  const menu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    const u = users[id];
    if (!capable || !u) return; // the host checks the viewer's role
    openMenu(e, [
      { label: u.nickname, icon: "user", disabled: true },
      controllerId === id
        ? { label: t("remote.take"), icon: "pointer", danger: true, onSelect: () => void remote.revoke() }
        : { label: t("remote.give"), icon: "pointer", onSelect: () => void remote.give(id) },
    ]);
  };
  return (
    <div className={s.viewerList} aria-label={t("remote.viewers")}>
      {viewers.map((id) => users[id] && (
        <button key={id} className={cx(s.viewer, controllerId === id && s.viewerCtl)} title={users[id]!.nickname} onClick={(e) => menu(e, id)} onContextMenu={(e) => menu(e, id)}>
          <Avatar user={users[id]!} size={24} />
          {controllerId === id && <Icon name="pointer" size={12} />}
        </button>
      ))}
    </div>
  );
}

/**
 * Streams being watched. Several: side by side; clicking one makes it fill the stage and hides the others,
 * clicking the focused one goes back to side by side. One: it fills the stage.
 */
function WatchArea({ ids, focus, states }: { ids: string[]; focus: string | null; states: VoiceState[] }) {
  const watching = useVoice((x) => x.watching);
  const focused = focus && ids.includes(focus) ? focus : null;
  if (focused && ids.length > 1) {
    return (
      <div className={s.watchFocus}>
        <WatchTile userId={focused} w={watching[focused] ?? null} state={states.find((x) => x.userId === focused)} big onPick={() => voice.setFocus(null)} />
      </div>
    );
  }
  return (
    <div className={ids.length === 1 ? s.watchFocus : s.watchGrid}>
      {ids.map((id) => <WatchTile key={id} userId={id} w={watching[id] ?? null} state={states.find((x) => x.userId === id)} big={ids.length === 1} onPick={ids.length > 1 ? () => voice.setFocus(id) : undefined} />)}
    </div>
  );
}

type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => void };
type IosVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void; webkitSupportsFullscreen?: boolean };

/**
 * Fullscreen for a stream tile. Element fullscreen where the browser has it (desktop, Android, iPad);
 * iPhone Safari only lets a <video> go fullscreen, so use the native player there; otherwise fill the window with CSS.
 */
async function toggleFullscreen(el: HTMLElement, fallback: () => void): Promise<void> {
  const d = document as FsDoc;
  if (d.fullscreenElement || d.webkitFullscreenElement) {
    if (d.exitFullscreen) await d.exitFullscreen().catch(() => {});
    else d.webkitExitFullscreen?.();
    return;
  }
  const f = el as FsEl;
  try {
    if (f.requestFullscreen) {
      await f.requestFullscreen();
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.("landscape").catch(() => {});
      return;
    }
    if (f.webkitRequestFullscreen) { f.webkitRequestFullscreen(); return; }
  } catch { /* fall through */ }
  const v = el.querySelector("video") as IosVideo | null;
  if (v?.webkitEnterFullscreen && v.webkitSupportsFullscreen !== false) { v.webkitEnterFullscreen(); return; }
  fallback();
}

type PipVideo = HTMLVideoElement & { webkitSupportsPresentationMode?: (m: string) => boolean; webkitSetPresentationMode?: (m: string) => void; webkitPresentationMode?: string };

/** Floating mini player (Picture-in-Picture): standard API, or Safari's presentation mode on iPhone. */
function pipSupported(): boolean {
  if (typeof document === "undefined") return false;
  if ((document as Document & { pictureInPictureEnabled?: boolean }).pictureInPictureEnabled) return true;
  const v = document.createElement("video") as PipVideo;
  return !!v.webkitSupportsPresentationMode && typeof v.webkitSetPresentationMode === "function";
}
const PIP = pipSupported();

async function togglePip(tile: HTMLElement): Promise<void> {
  const v = tile.querySelector("video") as PipVideo | null;
  if (!v) return;
  const d = document as Document & { pictureInPictureElement?: Element | null; exitPictureInPicture?: () => Promise<void> };
  try {
    if (d.pictureInPictureElement) { await d.exitPictureInPicture?.(); return; }
    if (v.webkitSetPresentationMode && v.webkitSupportsPresentationMode?.("picture-in-picture")) {
      v.webkitSetPresentationMode(v.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture");
      return;
    }
    await v.requestPictureInPicture();
  } catch { /* refused (no video frame yet) */ }
}

function WatchTile({ userId, w, state, big, onPick }: { userId: string; w: WatchedStream | null; state: VoiceState | undefined; big?: boolean; onPick?: () => void }) {
  const user = useStore((st) => st.users[userId]);
  const deafened = useVoice((x) => x.deafened);
  const focus = useVoice((x) => x.focus);
  const many = useVoice((x) => Object.keys(x.watching).length > 1);
  const vol = useVoiceSettings((st) => st.volumes[`stream:${userId}`] ?? 1);
  const ref = useRef<HTMLDivElement>(null);
  const [pseudo, setPseudo] = useState(false);
  useEffect(() => {
    if (!pseudo) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && setPseudo(false);
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [pseudo]);
  const live = w?.hasVideo;
  const rc = useRemote(useShallow((x) => ({ asked: x.asked === userId, controlling: x.controlling === userId })));
  // Any client may control (browser and phone too) when a role allows it; only desktop streamers can be controlled.
  const canAsk = big && live && !!state?.stream?.controllable && has(useStore.getState().guilds[state.guildId]?.myPerms ?? 0, P.REQUEST_REMOTE_CONTROL);
  return (
    <div ref={ref} className={cx(s.tile, big && s.big, onPick && !rc.controlling && s.tileClickable, pseudo && s.pseudoFs)} onClick={() => { if (!rc.controlling && !pseudo && !(document as FsDoc).fullscreenElement && !(document as FsDoc).webkitFullscreenElement) onPick?.(); }}>
      {w && live ? <StreamVideo stream={w.stream} muted={deafened} volume={vol} /> : <div className={s.tileCenter}><Spinner />{t("stream.loading")}</div>}
      {rc.controlling && live && <RemoteSurface tileRef={ref} />}
      <div className={s.tileBar} onClick={(e) => e.stopPropagation()}>
        <div className={s.tileName}>{state?.stream && <LiveBadge />}<span>{user?.nickname}</span></div>
        {big && w?.hasAudio && (
          <input className={s.tileVol} type="range" min={0} max={100} value={Math.round(vol * 100)} aria-label={t("voice.volume")}
            onChange={(e) => useVoiceSettings.getState().set({ volumes: { ...useVoiceSettings.getState().volumes, [`stream:${userId}`]: Number(e.target.value) / 100 } })} />
        )}
        {many && (big && focus === userId
          ? <button className={s.tileBtn} title={t("stream.grid")} aria-label={t("stream.grid")} onClick={() => voice.setFocus(null)}><Icon name="grid" size={16} /></button>
          : <button className={s.tileBtn} title={t("stream.focus")} aria-label={t("stream.focus")} onClick={() => voice.setFocus(userId)}><Icon name="fullscreen" size={16} /></button>)}
        {canAsk && (rc.controlling
          ? <button className={cx(s.tileBtn, s.tileBtnOn)} title={t("remote.release")} aria-label={t("remote.release")} onClick={() => void remote.release()}><Icon name="hand" size={16} /></button>
          : <button className={s.tileBtn} disabled={rc.asked} title={rc.asked ? t("remote.requested") : t("remote.request")} aria-label={t("remote.request")} onClick={() => void remote.request(userId)}><Icon name="hand" size={16} /></button>)}
        {PIP && live && <button className={s.tileBtn} title={t("stream.pip")} aria-label={t("stream.pip")} onClick={() => { if (ref.current) void togglePip(ref.current); }}><Icon name="pip" size={16} /></button>}
        <button className={s.tileBtn} title={t("stream.fullscreen")} aria-label={t("stream.fullscreen")} onClick={() => { if (pseudo) setPseudo(false); else if (ref.current) void toggleFullscreen(ref.current, () => setPseudo(true)); }}><Icon name="fullscreen" size={16} /></button>
        <button className={s.tileBtn} title={t("stream.unwatch")} aria-label={t("stream.unwatch")} onClick={() => void voice.unwatch(userId)}><Icon name="eye-off" size={16} /></button>
      </div>
    </div>
  );
}

/** Camera on/off from a click (getUserMedia must start inside the gesture on iPhone). */
export function toggleCamera(on: boolean) {
  if (on) void voice.stopCamera();
  else voice.startCamera().catch((e: Error) => useStore.getState().toast(e.message, "error"));
}

export const cameraSupported = (): boolean => typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

function CallControls({ guildId, onShare }: { guildId: string; onShare: () => void }) {
  const v = useVoice(useShallow((x) => ({ muted: x.muted, deafened: x.deafened, sharing: !!x.sharing, status: x.status, transport: x.transport, camera: x.camera })));
  const myPerms = useStore((st) => st.guilds[guildId]?.myPerms ?? 0);
  const canStream = has(myPerms, P.STREAM) && platform.canShareScreen;
  const canCam = has(myPerms, P.VIDEO) && cameraSupported();
  return (
    <div className={s.controls}>
      <button className={cx(s.ctrl, v.muted && s.off)} aria-pressed={v.muted} title={v.muted ? t("voice.unmute") : t("voice.mute")} onClick={() => void voice.setMuted(!v.muted)}>
        <Icon name={v.muted ? "mic-off" : "mic"} size={22} label={v.muted ? t("voice.unmute") : t("voice.mute")} />
      </button>
      <button className={cx(s.ctrl, v.deafened && s.off)} aria-pressed={v.deafened} title={v.deafened ? t("voice.undeafen") : t("voice.deafen")} onClick={() => void voice.setDeafened(!v.deafened)}>
        <Icon name={v.deafened ? "headphones-off" : "headphones"} size={22} label={v.deafened ? t("voice.undeafen") : t("voice.deafen")} />
      </button>
      {canCam && (
        <button className={cx(s.ctrl, v.camera && s.accent)} aria-pressed={!!v.camera} title={v.camera ? t("voice.cameraOff") : t("voice.cameraOn")} disabled={v.status !== "connected"} onClick={() => toggleCamera(!!v.camera)}>
          <Icon name={v.camera ? "video" : "video-off"} size={22} label={v.camera ? t("voice.cameraOff") : t("voice.cameraOn")} />
        </button>
      )}
      {v.camera?.canFlip && (
        <button className={s.ctrl} title={t("voice.cameraFlip")} onClick={() => void voice.flipCamera().catch((e: Error) => useStore.getState().toast(e.message, "error"))}>
          <Icon name="camera-flip" size={22} label={t("voice.cameraFlip")} />
        </button>
      )}
      {canStream && (
        <button className={cx(s.ctrl, v.sharing && s.accent)} title={v.sharing ? t("stream.stop") : t("stream.share")} disabled={v.status !== "connected"} onClick={() => (v.sharing ? void voice.stopScreen() : onShare())}>
          <Icon name={v.sharing ? "screen-stop" : "screen-share"} size={22} label={v.sharing ? t("stream.stop") : t("stream.share")} />
        </button>
      )}
      <button className={cx(s.ctrl, s.hang)} title={t("voice.leave")} onClick={() => void voice.leave()}>
        <Icon name="phone-hangup" size={22} label={t("voice.leave")} />
      </button>
    </div>
  );
}
