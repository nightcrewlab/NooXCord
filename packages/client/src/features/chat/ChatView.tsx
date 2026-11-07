import { useCallback, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { P, type Channel, type GuildState, type Message } from "@nooxcord/shared";
import { t } from "../../i18n";
import { DM_HOME, useStore } from "../../state/store";
import { IconButton } from "../../ui";
import layout from "../layout/layout.module.css";
import s from "./chat.module.css";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

/** DM conversations have no guild: present them as a text channel with fixed permissions. */
const DM_PERMS = P.VIEW_CHANNELS | P.SEND_MESSAGES | P.ATTACH_FILES;
function useDmView(channelId: string | undefined, enabled: boolean): { gs: GuildState; channel: Channel } | undefined {
  const dm = useStore((st) => (enabled && channelId ? st.dms[channelId] : undefined));
  const meId = useStore((st) => st.me?.id);
  const other = useStore((st) => (dm ? st.users[dm.userIds.find((id) => id !== meId) ?? ""] : undefined));
  if (!dm) return undefined;
  const channel: Channel = { id: dm.id, guildId: DM_HOME, name: other?.nickname ?? "?", kind: "text", topic: "", position: 0, lastMessageId: dm.lastMessageId };
  const gs: GuildState = {
    guild: { id: DM_HOME, name: "", icon: null, ownerId: "", createdAt: 0 },
    channels: [channel], roles: [], members: [], myPerms: DM_PERMS, voice: [],
  };
  return { gs, channel };
}

export function ChatView({ guildId, channelId }: { guildId: string; channelId: string | undefined }) {
  const isDm = guildId === DM_HOME;
  const dmView = useDmView(channelId, isDm);
  const guildGs = useStore((st) => st.guilds[guildId]);
  const gs = isDm ? dmView?.gs : guildGs;
  const showMembers = useStore((st) => st.showMembers);
  const toggleMembers = useStore((st) => st.toggleMembers);
  const me = useStore((st) => st.me);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const channel = isDm ? dmView?.channel : gs?.channels.find((c) => c.id === channelId && c.kind === "text");

  const onEditLast = useCallback(() => {
    if (!channel) return;
    const items = useStore.getState().messages[channel.id]?.items ?? [];
    const last = [...items].reverse().find((m) => m.authorId === me?.id);
    if (last) setEditing(last.id);
  }, [channel, me?.id]);

  if (!gs && !isDm) return null;
  if (!channel || !gs) {
    return (
      <main className={layout.card}>
        <div className={layout.empty}><div className={layout.emptyInner}><div className={layout.emptyIcon}><Icon name={isDm ? "mail" : "hash"} size={30} /></div><p className={layout.emptyDesc}>{isDm ? t("dm.pick") : t("channel.none")}</p></div></div>
      </main>
    );
  }

  return (
    <main className={layout.card} key={channel.id}>
      <header className={s.head}>
        <Icon name={isDm ? "at" : "hash"} size={22} />
        <span className={s.headName}>{channel.name}</span>
        {channel.topic && <span className={s.headTopic} title={channel.topic}>{channel.topic}</span>}
        <span style={{ flex: 1 }} />
        {!isDm && <IconButton icon="users" label={t("members.toggle")} aria-pressed={showMembers} onClick={toggleMembers} />}
      </header>
      <MessageList channel={channel} gs={gs} onReply={setReplyTo} editing={editing} setEditing={setEditing} />
      <Composer channel={channel} gs={gs} replyTo={replyTo} clearReply={() => setReplyTo(null)} onEditLast={onEditLast} />
    </main>
  );
}
