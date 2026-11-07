import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Button, Spinner } from "../../ui";
import { ChannelPanel } from "../channels/ChannelPanel";
import { ChatView } from "../chat/ChatView";
import { CreateGuildModal } from "../guilds/CreateGuildModal";
import { GuildRail } from "../guilds/GuildRail";
import { MemberPanel } from "../members/MemberPanel";
import { ShareModal } from "../voice/ShareModal";
import { VoiceStage } from "../voice/VoiceStage";
import { openShareModal, useShareModal } from "../voice/common";
import s from "./layout.module.css";

export function AppShell() {
  const ready = useStore((st) => !!st.me && st.connStatus !== "connecting");
  const connStatus = useStore((st) => st.connStatus);
  const selectedGuild = useStore((st) => st.selectedGuild);
  const gs = useStore((st) => (st.selectedGuild ? st.guilds[st.selectedGuild] : undefined));
  const selectedChannel = useStore((st) => (st.selectedGuild ? st.selectedChannel[st.selectedGuild] : undefined));
  const selectChannel = useStore((st) => st.selectChannel);
  const showMembers = useStore((st) => st.showMembers);
  const [creating, setCreating] = useState(false);
  const shareOpen = useShareModal((x) => x.open);
  const selected = gs?.channels.find((c) => c.id === selectedChannel);

  // Pick the first text channel when a guild is opened (or the selected one disappears).
  useEffect(() => {
    if (!gs) return;
    if (selectedChannel && gs.channels.some((c) => c.id === selectedChannel)) return;
    const first = gs.channels.filter((c) => c.kind === "text").sort((a, b) => a.position - b.position)[0];
    if (first) selectChannel(gs.guild.id, first.id);
  }, [gs, selectedChannel, selectChannel]);

  if (!ready) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--nx-text-2)" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><Spinner />{t("conn.connecting")}</div>
      </div>
    );
  }

  return (
    <div className={s.shell} style={{ gridTemplateColumns: `72px ${gs ? "248px" : ""} minmax(0, 1fr) ${gs && showMembers ? "auto" : ""}` }}>
      {connStatus === "reconnecting" && <div className={s.banner} role="status">{t("conn.reconnecting")}</div>}
      <GuildRail />
      {shareOpen && <ShareModal onClose={() => useShareModal.setState({ open: false })} />}
      {gs && selectedGuild ? (
        <>
          <ChannelPanel guildId={selectedGuild} />
          {selected?.kind === "voice" ? <VoiceStage guildId={selectedGuild} channel={selected} onShare={openShareModal} /> : <ChatView guildId={selectedGuild} channelId={selectedChannel} />}
          {showMembers && <MemberPanel guildId={selectedGuild} />}
        </>
      ) : (
        <main className={s.card}>
          <div className={s.empty}>
            <div className={s.emptyInner}>
              <div className={s.emptyIcon}><Icon name="server" size={30} /></div>
              <h2 className={s.emptyTitle}>{t("guild.empty")}</h2>
              <p className={s.emptyDesc}>{t("guild.emptyDesc")}</p>
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{t("rail.addGuild")}</Button>
            </div>
          </div>
          {creating && <CreateGuildModal onClose={() => setCreating(false)} />}
        </main>
      )}
    </div>
  );
}
