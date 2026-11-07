import { useMemo } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Avatar } from "../../ui";
import { roleColor } from "../chat/MessageList";
import layout from "../layout/layout.module.css";
import s from "./members.module.css";
import { useUserMenu } from "./useUserMenu";

export function MemberPanel({ guildId }: { guildId: string }) {
  const gs = useStore((st) => st.guilds[guildId]);
  const users = useStore((st) => st.users);
  const menu = useUserMenu(gs);

  const { online, offline } = useMemo(() => {
    const on: string[] = [];
    const off: string[] = [];
    for (const m of gs?.members ?? []) (users[m.userId]?.online ? on : off).push(m.userId);
    const byName = (a: string, b: string) => (users[a]?.nickname ?? "").localeCompare(users[b]?.nickname ?? "", "tr");
    return { online: on.sort(byName), offline: off.sort(byName) };
  }, [gs?.members, users]);

  if (!gs) return null;

  const row = (id: string) => {
    const u = users[id];
    if (!u) return null;
    return (
      <button key={id} className={s.member} data-offline={!u.online || undefined} onClick={(e) => menu(e, id)} onContextMenu={(e) => menu(e, id)}>
        <Avatar user={u} size={32} presence />
        <span className={s.name} style={{ color: roleColor(gs, id) ?? undefined }}>{u.nickname}</span>
        {gs.guild.ownerId === id && <span title={t("members.owner")} className={s.crown}><Icon name="crown" size={14} /></span>}
      </button>
    );
  };

  return (
    <aside className={`${layout.card} ${s.panel}`} aria-label={t("guild.members")}>
      <div className={s.scroll}>
        <div className={s.group}>{t("members.online")} — {online.length}</div>
        {online.map(row)}
        {offline.length > 0 && <div className={s.group}>{t("members.offline")} — {offline.length}</div>}
        {offline.map(row)}
      </div>
    </aside>
  );
}
