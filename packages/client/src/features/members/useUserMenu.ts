import { useCallback } from "react";
import { P, has, type GuildState } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { useConfirm, useMenu, type MenuItem } from "../../ui";

/** Right-click / click menu for a guild member: role toggles, kick, ban. */
export function useUserMenu(gs: GuildState | undefined) {
  const openMenu = useMenu();
  const confirm = useConfirm();
  const conn = useStore((st) => st.conn);
  const me = useStore((st) => st.me);
  const toast = useStore((st) => st.toast);

  return useCallback(
    (e: React.MouseEvent, userId: string) => {
      e.preventDefault();
      if (!gs || !me) return;
      const user = useStore.getState().users[userId];
      const member = gs.members.find((m) => m.userId === userId);
      const items: MenuItem[] = [{ label: user?.nickname ?? "?", icon: "user", disabled: true }];
      if (userId !== me.id) items.push({ label: t("dm.send"), icon: "mail", onSelect: () => void useStore.getState().openDm(userId) });
      const isOwnerTarget = gs.guild.ownerId === userId;
      if (member && has(gs.myPerms, P.MANAGE_ROLES) && !(isOwnerTarget && me.id !== userId)) {
        const roles = gs.roles.filter((r) => !r.isDefault).sort((a, b) => b.position - a.position);
        if (roles.length) items.push({ separator: true, label: "" });
        for (const r of roles) {
          const on = member.roleIds.includes(r.id);
          items.push({
            label: r.name,
            checked: on,
            keepOpen: false,
            onSelect: () => {
              const roleIds = on ? member.roleIds.filter((x) => x !== r.id) : [...member.roleIds, r.id];
              conn?.call("member.setRoles", { guildId: gs.guild.id, userId, roleIds }).catch((err: Error) => toast(err.message, "error"));
            },
          });
        }
      }
      if (member && userId !== me.id && !isOwnerTarget) {
        const name = user?.nickname ?? "?";
        const mod: MenuItem[] = [];
        if (has(gs.myPerms, P.KICK_MEMBERS))
          mod.push({
            label: t("members.kick"), icon: "logout", danger: true,
            onSelect: async () => {
              if (await confirm({ title: t("members.kick"), body: t("members.kickConfirm", { user: name }), confirm: t("members.kick"), danger: true }))
                conn?.call("member.kick", { guildId: gs.guild.id, userId }).catch((err: Error) => toast(err.message, "error"));
            },
          });
        if (has(gs.myPerms, P.BAN_MEMBERS))
          mod.push({
            label: t("members.ban"), icon: "shield", danger: true,
            onSelect: async () => {
              if (await confirm({ title: t("members.ban"), body: t("members.banConfirm", { user: name }), confirm: t("members.ban"), danger: true }))
                conn?.call("member.ban", { guildId: gs.guild.id, userId }).catch((err: Error) => toast(err.message, "error"));
            },
          });
        if (mod.length) items.push({ separator: true, label: "" }, ...mod);
      }
      openMenu(e, items);
    },
    [gs, me, conn, openMenu, confirm, toast],
  );
}
