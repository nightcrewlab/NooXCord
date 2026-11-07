import { useState } from "react";
import { Icon } from "@nooxcord/icons";
import type { GuildState } from "@nooxcord/shared";
import logoUrl from "../../assets/logo.svg";
import { t } from "../../i18n";
import { initials } from "../../lib/format";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { cx, useMenu } from "../../ui";
import s from "../layout/layout.module.css";
import { CreateGuildModal } from "./CreateGuildModal";

export function hasUnread(g: GuildState, readStates: Record<string, string>): boolean {
  return g.channels.some((c) => c.kind === "text" && c.lastMessageId && c.lastMessageId > (readStates[c.id] ?? ""));
}

export function GuildRail() {
  const order = useStore((st) => st.guildOrder);
  const guilds = useStore((st) => st.guilds);
  const selected = useStore((st) => st.selectedGuild);
  const readStates = useStore((st) => st.readStates);
  const selectGuild = useStore((st) => st.selectGuild);
  const leaveHost = useStore((st) => st.leaveHost);
  const hostInfo = useStore((st) => st.hostInfo);
  const http = useStore((st) => st.http);
  const openMenu = useMenu();
  const [creating, setCreating] = useState(false);
  const guest = useStore((st) => !!st.me?.guest);

  return (
    <nav className={s.rail} aria-label={t("rail.home")}>
      <div className={s.railItem}>
        <button
          className={cx(s.railBtn, s.railHome)}
          title={hostInfo?.name}
          onClick={(e) =>
            openMenu({ clientX: e.clientX + 8, clientY: e.clientY + 8 }, [
              { label: hostInfo?.name ?? "", icon: "server", disabled: true },
              ...(platform.fixedHost ? [] : [{ label: t("hosts.switch"), icon: "refresh" as const, onSelect: () => void leaveHost() }]),
            ])
          }
        >
          <img src={logoUrl} alt="NooXCord" />
        </button>
      </div>
      <div className={s.railSep} />
      {order.map((id) => {
        const g = guilds[id];
        if (!g) return null;
        const icon = http?.url(g.guild.icon);
        return (
          <div key={id} className={cx(s.railItem, selected === id && s.active, selected !== id && hasUnread(g, readStates) && s.unread)}>
            <span className={s.pill} />
            <button className={s.railBtn} title={g.guild.name} aria-label={g.guild.name} aria-current={selected === id} onClick={() => selectGuild(id)}>
              {icon ? <img src={icon} alt="" /> : initials(g.guild.name)}
            </button>
          </div>
        );
      })}
      {!guest && <div className={s.railItem}>
        <button className={cx(s.railBtn, s.railAdd)} title={t("rail.addGuild")} aria-label={t("rail.addGuild")} onClick={() => setCreating(true)}>
          <Icon name="plus" size={22} />
        </button>
      </div>}
      {creating && <CreateGuildModal onClose={() => setCreating(false)} />}
    </nav>
  );
}
