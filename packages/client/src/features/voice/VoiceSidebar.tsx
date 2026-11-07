import { useShallow } from "zustand/react/shallow";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { useVoice, voice } from "../../media/engine";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { Avatar, cx } from "../../ui";
import { LiveBadge, useChannelVoice, useIsSpeaking, useVolumePopover } from "./common";
import s from "./voice.module.css";

/** People in a voice channel, listed under the channel in the sidebar. */
export function VoiceChannelUsers({ guildId, channelId }: { guildId: string; channelId: string }) {
  const states = useChannelVoice(guildId, channelId);
  const pop = useVolumePopover();
  if (states.length === 0) return null;
  return (
    <div className={s.users}>
      {states.map((v) => <VoiceUserRow key={v.userId} channelId={channelId} userId={v.userId} muted={v.muted || v.suppressed} deafened={v.deafened} live={!!v.stream} onVolume={pop.open} />)}
      {pop.node}
    </div>
  );
}

function VoiceUserRow({ channelId, userId, muted, deafened, live, onVolume }: { channelId: string; userId: string; muted: boolean; deafened: boolean; live: boolean; onVolume: (e: React.MouseEvent, id: string, name: string) => void }) {
  const user = useStore((st) => st.users[userId]);
  const meId = useStore((st) => st.me?.id);
  const speaking = useIsSpeaking(channelId, userId);
  if (!user) return null;
  return (
    <div className={cx(s.user, speaking && s.speaking)} onContextMenu={(e) => userId !== meId && onVolume(e, userId, user.nickname)}>
      <span className={cx(s.ring, speaking && s.ringOn)}><Avatar user={user} size={22} /></span>
      <span className={s.name}>{user.nickname}</span>
      {live && <LiveBadge />}
      <span className={s.stateIcons}>
        {muted && <Icon name="mic-off" size={14} label={t("voice.unmute")} />}
        {deafened && <Icon name="headphones-off" size={14} label={t("voice.undeafen")} />}
      </span>
    </div>
  );
}

/** Connection panel shown above the user row while in voice. */
export function VoiceBar({ onShare }: { onShare: () => void }) {
  const v = useVoice(useShallow((x) => ({ guildId: x.guildId, channelId: x.channelId, status: x.status, sharing: !!x.sharing })));
  const channel = useStore((st) => (v.guildId ? st.guilds[v.guildId]?.channels.find((c) => c.id === v.channelId) : undefined));
  const guildName = useStore((st) => (v.guildId ? st.guilds[v.guildId]?.guild.name : ""));
  const selectChannel = useStore((st) => st.selectChannel);
  if (!v.channelId || !v.guildId) return null;
  const ok = v.status === "connected";
  return (
    <div className={s.bar}>
      <div className={s.barTop}>
        <div className={s.barStatus}>
          <div className={cx(s.barTitle, !ok && s.warn)}>
            <Icon name="signal" size={16} />
            {ok ? t("voice.connected") : v.status === "reconnecting" ? t("voice.reconnecting") : t("voice.connecting")}
          </div>
          <button className={s.barChan} onClick={() => selectChannel(v.guildId!, v.channelId!)}>{channel?.name ?? ""} / {guildName}</button>
        </div>
        <button className={cx(s.barBtn, s.hangup)} style={{ width: 34, padding: 0 }} aria-label={t("voice.leave")} title={t("voice.leave")} onClick={() => void voice.leave()}>
          <Icon name="phone-hangup" size={18} />
        </button>
      </div>
      {platform.canShareScreen && (
        <div className={s.barBtns} style={{ gridTemplateColumns: "1fr" }}>
          {v.sharing ? (
            <button className={cx(s.barBtn, s.on)} onClick={() => void voice.stopScreen()}><Icon name="screen-stop" size={16} />{t("stream.stop")}</button>
          ) : (
            <button className={s.barBtn} onClick={onShare} disabled={!ok}><Icon name="screen-share" size={16} />{t("stream.share")}</button>
          )}
        </div>
      )}
    </div>
  );
}
