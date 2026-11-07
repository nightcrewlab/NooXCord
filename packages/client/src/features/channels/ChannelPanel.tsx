import { useState } from "react";
import { Icon } from "@nooxcord/icons";
import { P, has, type Channel, type ChannelKind } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Avatar, IconButton, cx, useConfirm, useMenu, type MenuItem } from "../../ui";
import { GuildSettingsModal } from "../guilds/GuildSettingsModal";
import { InviteModal } from "../guilds/InviteModal";
import s from "../layout/layout.module.css";
import { SettingsModal } from "../settings/SettingsModal";
import { ChannelModal } from "./ChannelModal";
import { useVoice, voice as engine } from "../../media/engine";
import { openShareModal } from "../voice/common";
import { useNotify } from "../notify/notify";
import { VoiceBar, VoiceChannelUsers } from "../voice/VoiceSidebar";
import vs from "../voice/voice.module.css";

/** Bottom bar of the side panel: you, mute/deafen, settings. */
export function MeBar() {
  const me = useStore((st) => st.me);
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const [open, setOpen] = useState(false);
  if (!me) return null;
  return (
    <div className={s.me}>
      <Avatar user={me} size={34} presence />
      <button className={s.meInfo} onClick={() => setOpen(true)}>
        <div className={s.meName}>{me.nickname}</div>
        <div className={s.meStatus}>{t(`status.${me.status}`)}</div>
      </button>
      <IconButton icon={muted ? "mic-off" : "mic"} className={muted ? vs.meBtnOff : undefined} label={muted ? t("voice.unmute") : t("voice.mute")} aria-pressed={muted} onClick={() => void engine.setMuted(!muted)} />
      <IconButton icon={deafened ? "headphones-off" : "headphones"} className={deafened ? vs.meBtnOff : undefined} label={deafened ? t("voice.undeafen") : t("voice.deafen")} aria-pressed={deafened} onClick={() => void engine.setDeafened(!deafened)} />
      <IconButton icon="settings" label={t("rail.settings")} onClick={() => setOpen(true)} />
      {open && <SettingsModal onClose={() => setOpen(false)} />}
    </div>
  );
}

export function ChannelPanel({ guildId }: { guildId: string }) {
  const gs = useStore((st) => st.guilds[guildId]);
  const me = useStore((st) => st.me);
  const conn = useStore((st) => st.conn);
  const readStates = useStore((st) => st.readStates);
  const selectedChannel = useStore((st) => st.selectedChannel[guildId]);
  const selectChannel = useStore((st) => st.selectChannel);
  const toast = useStore((st) => st.toast);
  const inVoice = useVoice((v) => v.channelId);
  const openMenu = useMenu();
  const confirm = useConfirm();
  const [modal, setModal] = useState<null | { kind: "invite" } | { kind: "settings" } | { kind: "channel"; create?: ChannelKind; channel?: Channel }>(null);
  if (!gs || !me) return null;

  const perms = gs.myPerms;
  const isOwner = gs.guild.ownerId === me.id;
  const canManageChannels = has(perms, P.MANAGE_CHANNELS);
  const text = gs.channels.filter((c) => c.kind === "text").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const voice = gs.channels.filter((c) => c.kind === "voice").sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));

  function guildMenu(e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [];
    if (has(perms, P.CREATE_INVITES)) items.push({ label: t("guild.invite"), icon: "user-plus", onSelect: () => setModal({ kind: "invite" }) });
    if (has(perms, P.MANAGE_GUILD) || has(perms, P.MANAGE_ROLES)) items.push({ label: t("guild.settings"), icon: "settings", onSelect: () => setModal({ kind: "settings" }) });
    if (canManageChannels) items.push({ label: t("channel.create"), icon: "plus", onSelect: () => setModal({ kind: "channel", create: "text" }) });
    items.push({ separator: true, label: "" });
    if (isOwner) {
      items.push({
        label: t("guild.delete"), icon: "trash", danger: true,
        onSelect: async () => {
          if (await confirm({ title: t("guild.delete"), body: t("guild.deleteConfirm", { guild: gs!.guild.name }), confirm: t("common.delete"), danger: true }))
            conn?.call("guild.delete", { guildId }).catch((err: Error) => toast(err.message, "error"));
        },
      });
    } else {
      items.push({
        label: t("guild.leave"), icon: "logout", danger: true,
        onSelect: async () => {
          if (await confirm({ title: t("guild.leave"), body: t("guild.leaveConfirm", { guild: gs!.guild.name }), confirm: t("guild.leave"), danger: true }))
            conn?.call("guild.leave", { guildId }).catch((err: Error) => toast(err.message, "error"));
        },
      });
    }
    openMenu({ clientX: r.left + 8, clientY: r.bottom + 4 }, items);
  }

  function channelMenu(e: React.MouseEvent, c: Channel) {
    const items: MenuItem[] = [];
    if (c.kind === "text") {
      const off = useNotify.getState().muted.includes(c.id);
      items.push({ label: off ? t("notify.unmuteChannel") : t("notify.muteChannel"), icon: "bell-off", checked: off, onSelect: () => useNotify.getState().toggleChannel(c.id) });
    }
    if (canManageChannels) {
      items.push({ label: t("channel.edit"), icon: "edit", onSelect: () => setModal({ kind: "channel", channel: c }) });
      items.push({
        label: t("channel.delete"), icon: "trash", danger: true,
        onSelect: async () => {
          if (await confirm({ title: t("channel.delete"), body: t("channel.deleteConfirm", { channel: c.name }), confirm: t("common.delete"), danger: true }))
            conn?.call("channel.delete", { channelId: c.id }).catch((err: Error) => toast(err.message, "error"));
        },
      });
    }
    openMenu(e, items);
  }

  const renderGroup = (kind: ChannelKind, list: Channel[]) => (
    <div className={s.group}>
      <div className={s.groupHead}>
        <span>{kind === "text" ? t("channel.text") : t("channel.voice")}</span>
        {canManageChannels && <IconButton icon="plus" size={16} label={t("channel.create")} onClick={() => setModal({ kind: "channel", create: kind })} />}
      </div>
      {list.map((c) => {
        const unread = kind === "text" && !!c.lastMessageId && c.lastMessageId > (readStates[c.id] ?? "") && selectedChannel !== c.id;
        return (
          <div key={c.id}>
            <button
              className={cx(s.chan, selectedChannel === c.id && s.active, unread && s.unread)}
              onClick={() => {
                selectChannel(guildId, c.id);
                window.dispatchEvent(new CustomEvent("nx:channel-open", { detail: kind })); // mobile: show it
                // Joining happens inside the click so iOS allows audio + microphone.
                if (kind === "voice" && inVoice !== c.id && has(perms, P.CONNECT_VOICE)) void engine.join(guildId, c.id);
              }}
              onContextMenu={(e) => channelMenu(e, c)}
            >
              <Icon name={kind === "text" ? "hash" : "speaker"} size={18} />
              <span className={s.chanName}>{c.name}</span>
            </button>
            {kind === "voice" && <VoiceChannelUsers guildId={guildId} channelId={c.id} />}
          </div>
        );
      })}
    </div>
  );

  return (
    <aside className={s.card}>
      <button className={s.guildHead} onClick={guildMenu} aria-haspopup="menu">
        <span className={s.guildName}>{gs.guild.name}</span>
        <Icon name="chevron-down" size={18} />
      </button>
      <div className={s.channels}>
        {renderGroup("text", text)}
        {renderGroup("voice", voice)}
      </div>
      <VoiceBar onShare={openShareModal} />
      <MeBar />
      {modal?.kind === "invite" && <InviteModal guildId={guildId} onClose={() => setModal(null)} />}
      {modal?.kind === "settings" && <GuildSettingsModal guildId={guildId} onClose={() => setModal(null)} />}
      {modal?.kind === "channel" && <ChannelModal guildId={guildId} kind={modal.create} channel={modal.channel} onClose={() => setModal(null)} />}
    </aside>
  );
}
