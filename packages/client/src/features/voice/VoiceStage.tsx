import { useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { Icon } from "@nooxcord/icons";
import { P, has, type Channel, type VoiceState } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useVoice, voice, type WatchedStream } from "../../media/engine";
import { useVoiceSettings } from "../../media/settings";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { Avatar, Button, IconButton, Spinner, cx } from "../../ui";
import chat from "../chat/chat.module.css";
import layout from "../layout/layout.module.css";
import { LiveBadge, StreamVideo, useChannelVoice, useIsSpeaking, useVolumePopover } from "./common";
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

  return (
    <main className={layout.card}>
      <header className={chat.head}>
        <Icon name="speaker" size={22} />
        <span className={chat.headName}>{channel.name}</span>
        <span style={{ flex: 1 }} />
        <IconButton icon="users" label={t("members.toggle")} aria-pressed={showMembers} onClick={toggleMembers} />
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
      ) : (
        <div className={s.stage}>
          <div className={s.stageScroll}>
            {watchedIds.length > 0 && <WatchArea ids={watchedIds} focus={v.focus} states={states} />}

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

function JoinFace({ userId }: { userId: string }) {
  const user = useStore((st) => st.users[userId]);
  return user ? <span><Avatar user={user} size={36} /></span> : null;
}

function Person({ state, onVolume, isMe }: { state: VoiceState; onVolume: (e: React.MouseEvent, id: string, name: string) => void; isMe: boolean }) {
  const user = useStore((st) => st.users[state.userId]);
  const speaking = useIsSpeaking(state.channelId, state.userId);
  if (!user) return null;
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
    </div>
  );
}

/** Streams being watched: one big focused tile + thumbnails, or an even grid. */
function WatchArea({ ids, focus, states }: { ids: string[]; focus: string | null; states: VoiceState[] }) {
  const watching = useVoice((x) => x.watching);
  const focused = focus && ids.includes(focus) ? focus : null;
  if (focused && ids.length > 1) {
    return (
      <div className={s.watchArea}>
        <WatchTile userId={focused} w={watching[focused] ?? null} state={states.find((x) => x.userId === focused)} big />
        <div className={s.thumbs}>
          {ids.filter((id) => id !== focused).map((id) => <WatchTile key={id} userId={id} w={watching[id] ?? null} state={states.find((x) => x.userId === id)} />)}
        </div>
      </div>
    );
  }
  return (
    <div className={ids.length === 1 ? s.watchFocus : s.watchGrid}>
      {ids.map((id) => <WatchTile key={id} userId={id} w={watching[id] ?? null} state={states.find((x) => x.userId === id)} big={ids.length === 1} />)}
    </div>
  );
}

function WatchTile({ userId, w, state, big }: { userId: string; w: WatchedStream | null; state: VoiceState | undefined; big?: boolean }) {
  const user = useStore((st) => st.users[userId]);
  const deafened = useVoice((x) => x.deafened);
  const focus = useVoice((x) => x.focus);
  const many = useVoice((x) => Object.keys(x.watching).length > 1);
  const vol = useVoiceSettings((st) => st.volumes[`stream:${userId}`] ?? 1);
  const ref = useRef<HTMLDivElement>(null);
  const live = w?.hasVideo;
  return (
    <div ref={ref} className={cx(s.tile, big && s.big, !big && s.tileClickable)} onClick={() => !big && voice.setFocus(userId)}>
      {w && live ? <StreamVideo stream={w.stream} muted={deafened} volume={vol} /> : <div className={s.tileCenter}><Spinner />{t("stream.loading")}</div>}
      <div className={s.tileBar} onClick={(e) => e.stopPropagation()}>
        <div className={s.tileName}>{state?.stream && <LiveBadge />}<span>{user?.nickname}</span></div>
        {big && w?.hasAudio && (
          <input className={s.tileVol} type="range" min={0} max={100} value={Math.round(vol * 100)} aria-label={t("voice.volume")}
            onChange={(e) => useVoiceSettings.getState().set({ volumes: { ...useVoiceSettings.getState().volumes, [`stream:${userId}`]: Number(e.target.value) / 100 } })} />
        )}
        {many && (big && focus === userId
          ? <button className={s.tileBtn} title={t("stream.grid")} aria-label={t("stream.grid")} onClick={() => voice.setFocus(null)}><Icon name="grid" size={16} /></button>
          : <button className={s.tileBtn} title={t("stream.focus")} aria-label={t("stream.focus")} onClick={() => voice.setFocus(userId)}><Icon name="fullscreen" size={16} /></button>)}
        <button className={s.tileBtn} title={t("stream.fullscreen")} aria-label={t("stream.fullscreen")} onClick={() => void ref.current?.requestFullscreen?.().catch(() => {})}><Icon name="fullscreen" size={16} /></button>
        <button className={s.tileBtn} title={t("stream.unwatch")} aria-label={t("stream.unwatch")} onClick={() => void voice.unwatch(userId)}><Icon name="eye-off" size={16} /></button>
      </div>
    </div>
  );
}

function CallControls({ guildId, onShare }: { guildId: string; onShare: () => void }) {
  const v = useVoice(useShallow((x) => ({ muted: x.muted, deafened: x.deafened, sharing: !!x.sharing, status: x.status })));
  const myPerms = useStore((st) => st.guilds[guildId]?.myPerms ?? 0);
  const canStream = has(myPerms, P.STREAM) && platform.canShareScreen;
  return (
    <div className={s.controls}>
      <button className={cx(s.ctrl, v.muted && s.off)} aria-pressed={v.muted} title={v.muted ? t("voice.unmute") : t("voice.mute")} onClick={() => void voice.setMuted(!v.muted)}>
        <Icon name={v.muted ? "mic-off" : "mic"} size={22} label={v.muted ? t("voice.unmute") : t("voice.mute")} />
      </button>
      <button className={cx(s.ctrl, v.deafened && s.off)} aria-pressed={v.deafened} title={v.deafened ? t("voice.undeafen") : t("voice.deafen")} onClick={() => void voice.setDeafened(!v.deafened)}>
        <Icon name={v.deafened ? "headphones-off" : "headphones"} size={22} label={v.deafened ? t("voice.undeafen") : t("voice.deafen")} />
      </button>
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
