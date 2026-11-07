import { useEffect, useState, useSyncExternalStore } from "react";
import type { Channel } from "@nooxcord/shared";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { DM_HOME, useStore } from "../../state/store";
import { Button, Spinner, cx } from "../../ui";
import { ChannelPanel } from "../channels/ChannelPanel";
import { ChatView } from "../chat/ChatView";
import { CreateGuildModal } from "../guilds/CreateGuildModal";
import { GuildRail } from "../guilds/GuildRail";
import { MemberPanel } from "../members/MemberPanel";
import { SettingsModal } from "../settings/SettingsModal";
import { useVoice } from "../../media/engine";
import { ShareModal } from "../voice/ShareModal";
import { VoiceStage } from "../voice/VoiceStage";
import { DmPanel } from "../dm/DmPanel";
import { openShareModal, useShareModal } from "../voice/common";
import s from "./layout.module.css";

export function AppShell() {
  const guest = useStore((st) => !!st.me?.guest);
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
  const mobile = useMobile();

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

  if (mobile) {
    return (
      <>
        {connStatus === "reconnecting" && <div className={s.banner} role="status">{t("conn.reconnecting")}</div>}
        {shareOpen && <ShareModal onClose={() => useShareModal.setState({ open: false })} />}
        <MobileShell selected={selected} onCreate={() => setCreating(true)} />
        {creating && <CreateGuildModal onClose={() => setCreating(false)} />}
      </>
    );
  }

  return (
    <div className={s.shell} style={{ gridTemplateColumns: `72px ${gs || selectedGuild === DM_HOME ? "248px" : ""} minmax(0, 1fr) ${gs && showMembers ? "auto" : ""}` }}>
      {connStatus === "reconnecting" && <div className={s.banner} role="status">{t("conn.reconnecting")}</div>}
      <GuildRail />
      {shareOpen && <ShareModal onClose={() => useShareModal.setState({ open: false })} />}
      {selectedGuild === DM_HOME ? (
        <>
          <DmPanel />
          <ChatView guildId={DM_HOME} channelId={selectedChannel} />
        </>
      ) : gs && selectedGuild ? (
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
              <p className={s.emptyDesc}>{guest ? t("guild.emptyGuestDesc") : t("guild.emptyDesc")}</p>
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{guest ? t("guild.joinTitle") : t("rail.addGuild")}</Button>
            </div>
          </div>
          {creating && <CreateGuildModal onClose={() => setCreating(false)} />}
        </main>
      )}
    </div>
  );
}

// ---------- mobile (< 768 px, CLAUDE.md §9.1) ----------

const MQ = "(max-width: 767px)";
const subscribeMq = (cb: () => void) => {
  const m = window.matchMedia(MQ);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
export const useMobile = (): boolean => useSyncExternalStore(subscribeMq, () => window.matchMedia(MQ).matches);

type MobileTab = "servers" | "chat" | "voice";

/** One full-screen pane at a time plus a bottom tab bar: Servers / Chat / Voice / Profile. */
function MobileShell({ selected, onCreate }: { selected: Channel | undefined; onCreate: () => void }) {
  const guest = useStore((st) => !!st.me?.guest);
  const selectedGuild = useStore((st) => st.selectedGuild);
  const guilds = useStore((st) => st.guilds);
  const showMembers = useStore((st) => st.showMembers);
  const toggleMembers = useStore((st) => st.toggleMembers);
  const voiceGuild = useVoice((v) => v.guildId);
  const voiceChannel = useVoice((v) => v.channelId);
  const [tab, setTab] = useState<MobileTab>("servers");
  const [profile, setProfile] = useState(false);
  const [lastText, setLastText] = useState<{ guildId: string; channelId: string } | null>(null);

  // The member list is a desktop side panel; on a phone it is a page you open from the chat header.
  useEffect(() => {
    if (useStore.getState().showMembers) useStore.getState().toggleMembers();
  }, []);
  useEffect(() => {
    if (selected?.kind === "text" && selectedGuild) setLastText({ guildId: selectedGuild, channelId: selected.id });
  }, [selected, selectedGuild]);
  const dmSelected = useStore((st) => st.selectedChannel[DM_HOME]);
  useEffect(() => {
    if (selectedGuild === DM_HOME && dmSelected) setLastText({ guildId: DM_HOME, channelId: dmSelected });
  }, [selectedGuild, dmSelected]);
  // Tapping a channel in the list opens it.
  useEffect(() => {
    const open = (e: Event) => setTab((e as CustomEvent<"text" | "voice">).detail === "voice" ? "voice" : "chat");
    window.addEventListener("nx:channel-open", open);
    return () => window.removeEventListener("nx:channel-open", open);
  }, []);

  const voiceCh = voiceGuild && voiceChannel ? guilds[voiceGuild]?.channels.find((c) => c.id === voiceChannel) : undefined;
  const stageCh = voiceCh ?? (selected?.kind === "voice" ? selected : undefined);
  const stageGuild = voiceCh ? voiceGuild : selectedGuild;

  let body: React.ReactNode;
  if (tab === "servers" || !selectedGuild) {
    body = (
      <div className={s.mNav}>
        <GuildRail />
        {selectedGuild === DM_HOME ? <DmPanel /> : selectedGuild ? <ChannelPanel guildId={selectedGuild} /> : (
          <main className={s.card}>
            <div className={s.empty}><div className={s.emptyInner}>
              <div className={s.emptyIcon}><Icon name="server" size={30} /></div>
              <h2 className={s.emptyTitle}>{t("guild.empty")}</h2>
              <p className={s.emptyDesc}>{guest ? t("guild.emptyGuestDesc") : t("guild.emptyDesc")}</p>
              <Button variant="primary" icon="plus" onClick={onCreate}>{guest ? t("guild.joinTitle") : t("rail.addGuild")}</Button>
            </div></div>
          </main>
        )}
      </div>
    );
  } else if (tab === "chat") {
    body = showMembers ? <MemberPanel guildId={selectedGuild} /> : lastText ? <ChatView guildId={lastText.guildId} channelId={lastText.channelId} /> : <MobileEmpty icon="hash" text={t("mobile.pickText")} />;
  } else {
    body = stageCh && stageGuild ? <VoiceStage guildId={stageGuild} channel={stageCh} onShare={openShareModal} /> : <MobileEmpty icon="speaker" text={t("mobile.pickVoice")} />;
  }

  const tabs: { id: MobileTab | "profile"; icon: "server" | "hash" | "speaker" | "user"; label: string }[] = [
    { id: "servers", icon: "server", label: t("mobile.servers") },
    { id: "chat", icon: "hash", label: t("mobile.chat") },
    { id: "voice", icon: "speaker", label: t("mobile.voice") },
    { id: "profile", icon: "user", label: t("mobile.profile") },
  ];
  return (
    <div className={s.mShell}>
      <div className={s.mBody}>{body}</div>
      <nav className={s.mTabs} aria-label={t("mobile.tabs")}>
        {tabs.map((x) => (
          <button key={x.id} className={cx(s.mTab, (x.id === "profile" ? profile : tab === x.id) && s.mTabOn)} aria-current={x.id === tab}
            onClick={() => {
              if (x.id === "profile") return setProfile(true);
              if (x.id !== "chat" && showMembers) toggleMembers();
              setTab(x.id);
            }}>
            <span className={s.mTabIcon}>
              <Icon name={x.icon} size={22} />
              {x.id === "voice" && voiceChannel && <span className={s.mLive} />}
            </span>
            <span>{x.label}</span>
          </button>
        ))}
      </nav>
      {profile && <SettingsModal onClose={() => setProfile(false)} />}
    </div>
  );
}

function MobileEmpty({ icon, text }: { icon: "hash" | "speaker"; text: string }) {
  return (
    <main className={s.card} style={{ flex: 1 }}>
      <div className={s.empty}><div className={s.emptyInner}>
        <div className={s.emptyIcon}><Icon name={icon} size={30} /></div>
        <p className={s.emptyDesc}>{text}</p>
      </div></div>
    </main>
  );
}
