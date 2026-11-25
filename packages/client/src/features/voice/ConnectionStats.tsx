import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { useCallStats, useVoice, voice, type PeerStats } from "../../media/engine";
import { useVoiceSettings } from "../../media/settings";
import { useStore } from "../../state/store";
import { Avatar, Modal, cx } from "../../ui";
import s from "./voice.module.css";

/*
 * Ping chip and connection panel (CLAUDE.md §12.3). Media is peer to peer (ADR 0003), so there are two
 * different delays: the round trip to each person (what the voice actually travels) and the round trip
 * to the host (chat and call set-up only). The chip shows the first while someone is in the call with
 * me, otherwise the second; the panel shows both, and per person whether the two of us are connected
 * directly or through the TURN relay.
 */

const pingClass = (ms: number | null): string | undefined => (ms === null ? undefined : ms < 100 ? s.pingGood : ms < 200 ? s.pingOk : s.pingBad);
const lossClass = (pct: number | null): string | undefined => (pct === null ? undefined : pct < 1 ? s.pingGood : pct < 5 ? s.pingOk : s.pingBad);
const ms = (n: number | null): string => (n === null ? "–" : t("stats.ms", { n }));
const rate = (kbps: number | null): string => (kbps === null ? "–" : kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`);

/** My ping, as Discord shows it; a click opens the details. */
export function PingButton({ icon }: { icon?: boolean }) {
  const voicePing = useCallStats((x) => x.ping);
  const serverPing = useStore((st) => st.ping);
  const failed = useVoice((v) => Object.values(v.links).includes("failed"));
  const [open, setOpen] = useState(false);
  const ping = voicePing ?? serverPing;
  const tip = ping === null ? t("stats.pingTipNone") : t("stats.pingTip", { n: ping });
  return (
    <>
      <button className={cx(s.ping, failed ? s.pingBad : pingClass(ping))} onClick={() => setOpen(true)} title={tip} aria-label={tip}>
        {(icon || failed) && <Icon name={failed ? "alert" : "signal"} size={13} />}
        {ping === null ? "…" : t("stats.ms", { n: ping })}
      </button>
      {open && <ConnectionStats onClose={() => setOpen(false)} />}
    </>
  );
}

export function ConnectionStats({ onClose }: { onClose: () => void }) {
  const { peers, ping: voicePing } = useCallStats();
  const serverPing = useStore((st) => st.ping);
  const relayOnly = useVoiceSettings((x) => x.relayOnly);
  useEffect(() => void voice.refreshStats(), []);
  // Re-read on every sample: the relay list comes with the call.
  const hasRelay = voice.hasRelay();
  const anyFailed = peers.some((p) => p.state === "failed");
  return (
    <Modal title={t("stats.title")} onClose={onClose} medium>
      <div className={s.statTop}>
        <div className={s.statBox}>
          <div className={s.statLabel}>{t("stats.voicePing")}</div>
          <div className={cx(s.statValue, pingClass(voicePing))}>{ms(voicePing)}</div>
          <div className={s.statHint}>{t("stats.voicePingHint")}</div>
        </div>
        <div className={s.statBox}>
          <div className={s.statLabel}>{t("stats.serverPing")}</div>
          <div className={cx(s.statValue, pingClass(serverPing))}>{ms(serverPing)}</div>
          <div className={s.statHint}>{t("stats.serverPingHint")}</div>
        </div>
        <div className={s.statBox}>
          <div className={s.statLabel}>{t("stats.relay")}</div>
          <div className={s.statValue}>{hasRelay ? t("stats.relayYes") : t("stats.relayNo")}</div>
        </div>
      </div>

      {relayOnly && (
        <div className={cx(s.statNote, !hasRelay && s.warnNote)}>
          <Icon name={hasRelay ? "shield" : "alert"} size={18} />
          <span>{hasRelay ? t("stats.hideIpOn") : t("stats.hideIpIdle")}</span>
        </div>
      )}

      <div className={s.statTitle}>{t("stats.people")}</div>
      {peers.length === 0 ? (
        <div className={s.statNote}><Icon name="users" size={18} /><span>{t("stats.alone")}</span></div>
      ) : (
        <div className={s.statPeers}>{peers.map((p) => <PeerRow key={p.userId} p={p} />)}</div>
      )}
      {anyFailed && !hasRelay && (
        <div className={cx(s.statNote, s.warnNote)}><Icon name="alert" size={18} /><span>{t("stats.failedHint")}</span></div>
      )}
    </Modal>
  );
}

function PeerRow({ p }: { p: PeerStats }) {
  const user = useStore((st) => st.users[p.userId]);
  const connected = p.state === "connected";
  const path = p.state !== "connected" ? t(`stats.state.${p.state}`) : p.path ? `${t(`stats.path.${p.path}`)}${p.protocol ? ` · ${p.protocol.toUpperCase()}` : ""}` : "–";
  const cells: { label: string; value: string; className?: string }[] = [
    { label: t("stats.ping"), value: ms(p.rttMs), className: pingClass(p.rttMs) },
    { label: t("stats.loss"), value: p.lossPct === null ? "–" : `${p.lossPct}%`, className: lossClass(p.lossPct) },
    { label: t("stats.jitter"), value: ms(p.jitterMs) },
    { label: t("stats.up"), value: rate(p.upKbps) },
    { label: t("stats.down"), value: rate(p.downKbps) },
  ];
  if (p.videoIn) cells.push({ label: t("stats.videoIn"), value: p.videoIn });
  if (p.videoOut) cells.push({ label: t("stats.videoOut"), value: p.videoOut });
  return (
    <div className={s.statPeer}>
      <div className={s.statPeerHead}>
        {user && <Avatar user={user} size={24} />}
        <span className={s.statPeerName}>{user?.nickname ?? "?"}</span>
        <span className={cx(s.statPath, p.state === "failed" ? s.pingBad : !connected ? s.pingOk : p.path === "relay" ? s.pingOk : s.pingGood)}>{path}</span>
      </div>
      {connected && (
        <dl className={s.statGrid}>
          {cells.map((c) => (
            <div key={c.label} className={s.statCell}>
              <dt>{c.label}</dt>
              <dd className={c.className} title={c.value}>{c.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
