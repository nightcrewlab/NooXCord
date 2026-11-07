import { useCallback, useState } from "react";
import { Icon } from "@nooxcord/icons";
import type { Message } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { IconButton } from "../../ui";
import layout from "../layout/layout.module.css";
import s from "./chat.module.css";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ChatView({ guildId, channelId }: { guildId: string; channelId: string | undefined }) {
  const gs = useStore((st) => st.guilds[guildId]);
  const showMembers = useStore((st) => st.showMembers);
  const toggleMembers = useStore((st) => st.toggleMembers);
  const me = useStore((st) => st.me);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const channel = gs?.channels.find((c) => c.id === channelId && c.kind === "text");

  const onEditLast = useCallback(() => {
    if (!channel) return;
    const items = useStore.getState().messages[channel.id]?.items ?? [];
    const last = [...items].reverse().find((m) => m.authorId === me?.id);
    if (last) setEditing(last.id);
  }, [channel, me?.id]);

  if (!gs) return null;
  if (!channel) {
    return (
      <main className={layout.card}>
        <div className={layout.empty}><div className={layout.emptyInner}><div className={layout.emptyIcon}><Icon name="hash" size={30} /></div><p className={layout.emptyDesc}>{t("channel.none")}</p></div></div>
      </main>
    );
  }

  return (
    <main className={layout.card} key={channel.id}>
      <header className={s.head}>
        <Icon name="hash" size={22} />
        <span className={s.headName}>{channel.name}</span>
        {channel.topic && <span className={s.headTopic} title={channel.topic}>{channel.topic}</span>}
        <span style={{ flex: 1 }} />
        <IconButton icon="users" label={t("members.toggle")} aria-pressed={showMembers} onClick={toggleMembers} />
      </header>
      <MessageList channel={channel} gs={gs} onReply={setReplyTo} editing={editing} setEditing={setEditing} />
      <Composer channel={channel} gs={gs} replyTo={replyTo} clearReply={() => setReplyTo(null)} onEditLast={onEditLast} />
    </main>
  );
}
