import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { DM_HOME, useStore } from "../../state/store";
import { Avatar, cx, useMenu } from "../../ui";
import { useNotify } from "../notify/notify";
import { MeBar } from "../channels/ChannelPanel";
import s from "../layout/layout.module.css";
import { VoiceBar } from "../voice/VoiceSidebar";
import { openShareModal } from "../voice/common";

/** Direct messages: conversation list (newest first). */
export function DmPanel() {
  const dms = useStore((st) => st.dms);
  const users = useStore((st) => st.users);
  const me = useStore((st) => st.me);
  const readStates = useStore((st) => st.readStates);
  const selected = useStore((st) => st.selectedChannel[DM_HOME]);
  const selectChannel = useStore((st) => st.selectChannel);
  const openMenu = useMenu();
  const mutedIds = useNotify((n) => n.muted);
  const list = Object.values(dms).sort((a, b) => (b.lastMessageId ?? b.id).localeCompare(a.lastMessageId ?? a.id));

  return (
    <aside className={s.card}>
      <div className={s.guildHead} style={{ cursor: "default" }}>
        <span className={s.guildName}>{t("dm.title")}</span>
      </div>
      <div className={s.channels}>
        {list.length === 0 && <p className={s.dmEmpty}>{t("dm.empty")}</p>}
        {list.map((dm) => {
          const other = users[dm.userIds.find((id) => id !== me?.id) ?? ""];
          const unread = !!dm.lastMessageId && dm.lastMessageId > (readStates[dm.id] ?? "") && selected !== dm.id;
          return (
            <button
              key={dm.id}
              className={cx(s.chan, s.dmItem, selected === dm.id && s.active, unread && s.unread)}
              onContextMenu={(e) => openMenu(e, [{
                label: mutedIds.includes(dm.id) ? t("notify.unmuteChannel") : t("notify.muteChannel"), icon: "bell-off", checked: mutedIds.includes(dm.id),
                onSelect: () => useNotify.getState().toggleChannel(dm.id),
              }])}
              onClick={() => {
                selectChannel(DM_HOME, dm.id);
                window.dispatchEvent(new CustomEvent("nx:channel-open", { detail: "text" }));
              }}
            >
              {other ? <Avatar user={other} size={28} presence /> : <Icon name="user" size={18} />}
              <span className={s.chanName}>{other?.nickname ?? "?"}</span>
            </button>
          );
        })}
      </div>
      <VoiceBar onShare={openShareModal} />
      <MeBar />
    </aside>
  );
}
