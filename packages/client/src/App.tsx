import { useEffect, useState } from "react";
import { AuthScreen } from "./features/auth/AuthScreen";
import { HostPicker } from "./features/hosts/HostPicker";
import { AppShell } from "./features/layout/AppShell";
import { t } from "./i18n";
import { isEphemeralHost, platform } from "./platform";
import { useStore } from "./state/store";
import { ConfirmProvider, MenuProvider, Spinner, Toasts } from "./ui";
import { RemoteLayer } from "./features/remote/Remote";
import { UpdatePopup } from "./features/updates/UpdatePopup";
import { initNotifications } from "./features/notify/notify";
import { initVoiceSounds } from "./features/voice/sounds";
import { useVoice, voice } from "./media/engine";

initNotifications();
initVoiceSounds();

/** Desktop tray mirrors the call state and can mute/deafen. */
if (platform.app) {
  const app = platform.app;
  let last = "";
  const push = () => {
    const v = useVoice.getState();
    const st = { inVoice: !!v.channelId, muted: v.muted, deafened: v.deafened, live: !!v.sharing };
    const key = JSON.stringify(st);
    if (key !== last) app.setTrayState(st); // the voice store also changes for mic levels: send only real changes
    last = key;
  };
  push();
  useVoice.subscribe(push);
  app.onTrayAction((a) => {
    const v = useVoice.getState();
    if (a === "mute") void voice.setMuted(!v.muted);
    else void voice.setDeafened(!v.deafened);
  });
}

/**
 * Desktop start-up: open the last host. If that address is dead (an old quick-tunnel URL, or Hamachi
 * not connected yet right after Windows starts), try the other saved addresses of the same host, a
 * few rounds apart.
 */
async function resumeLastHost(openHost: (url: string) => Promise<void>): Promise<boolean> {
  const last = await platform.hosts.getLast();
  if (!last) return false;
  const saved = await platform.hosts.list().catch(() => []);
  const name = saved.find((h) => h.url === last)?.name;
  const others = name ? saved.filter((h) => h.name === name && h.url !== last && !isEphemeralHost(h.url)).map((h) => h.url) : [];
  const candidates = [...(isEphemeralHost(last) ? [] : [last]), ...others];
  for (let round = 0; round < 3; round++) {
    if (round) await new Promise((r) => setTimeout(r, 3000));
    for (const url of candidates) {
      try {
        await openHost(url);
        return true;
      } catch { /* try the next address */ }
    }
  }
  return false;
}

/** Invite code from ?invite=… (web links), consumed once after login. */
const webInvite = new URLSearchParams(location.search).get("invite");

export function App() {
  const screen = useStore((st) => st.screen);
  const openHost = useStore((st) => st.openHost);
  const connStatus = useStore((st) => st.connStatus);
  const conn = useStore((st) => st.conn);
  const selectGuild = useStore((st) => st.selectGuild);
  const toast = useStore((st) => st.toast);
  const [booting, setBooting] = useState(true);
  const [pendingInvite, setPendingInvite] = useState(webInvite);

  // Resume the last host (desktop) or the page's own host (web); a nooxcord://join link wins.
  useEffect(() => {
    void (async () => {
      const join = await platform.app?.takeJoin?.().catch(() => null);
      if (join?.invite) setPendingInvite(join.invite);
      const url = join?.url ?? platform.fixedHost;
      if (url) await openHost(url).catch(() => toast(t("hosts.unreachable"), "error"));
      else if (!(await resumeLastHost(openHost))) {
        if (await platform.hosts.getLast()) toast(t("hosts.unreachable"), "error");
      }
      setBooting(false);
    })();
  }, [openHost, toast]);

  // A join link opened while the app runs (second instance): switch to that host.
  useEffect(() => platform.app?.onJoin?.((j) => {
    if (j.invite) setPendingInvite(j.invite);
    if (useStore.getState().hostUrl === j.url) return;
    void (async () => {
      await useStore.getState().leaveHost();
      await openHost(j.url).catch(() => toast(t("hosts.unreachable"), "error"));
    })();
  }), [openHost, toast]);

  useEffect(() => {
    if (connStatus !== "ready" || !conn || !pendingInvite) return;
    if (webInvite) history.replaceState(null, "", location.pathname);
    setPendingInvite(null);
    conn.call("invite.join", { code: pendingInvite }).then((gs) => selectGuild(gs.guild.id), (e: Error) => toast(e.message, "error"));
  }, [connStatus, conn, pendingInvite, selectGuild, toast]);

  return (
    <ConfirmProvider>
      <MenuProvider>
        {booting ? (
          <div style={{ height: "100%", display: "grid", placeItems: "center", color: "var(--nx-text-2)" }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}><Spinner />{t("common.loading")}</div>
          </div>
        ) : screen === "hosts" ? (
          <HostPicker />
        ) : screen === "auth" ? (
          <AuthScreen />
        ) : (
          <AppShell />
        )}
        <Toasts />
        <RemoteLayer />
        <UpdatePopup />
      </MenuProvider>
    </ConfirmProvider>
  );
}
