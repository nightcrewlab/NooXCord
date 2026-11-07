import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Modal, Spinner } from "../../ui";

interface InviteLink { kind: "tunnel" | "hamachi" | "lan" | "current"; label: string; base: string }

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * When this client is the host's own desktop app, every way in (tunnel, Hamachi, LAN) gets a ready link.
 * Otherwise only the address this client used is known.
 */
async function inviteLinks(hostUrl: string): Promise<InviteLink[]> {
  const current: InviteLink = { kind: "current", label: t("guild.inviteLinkCurrent"), base: hostUrl };
  const { localHost, net, tunnel } = platform;
  if (!localHost) return [current];
  const st = await localHost.status().catch(() => null);
  let u: URL;
  try { u = new URL(hostUrl); } catch { return [current]; }
  const port = st?.running ? st.port : null;
  const own = port !== null && String(port) === u.port && (LOOPBACK.has(u.hostname) || (st?.lanAddresses ?? []).includes(u.host));
  if (!own) return [current];

  const out: InviteLink[] = [];
  const tun = await tunnel?.get().catch(() => null);
  if (tun?.status === "on" && tun.url) out.push({ kind: "tunnel", label: t("guild.inviteLinkTunnel"), base: tun.url.replace(/\/$/, "") });
  const addr = await net?.addresses().catch(() => null);
  if (addr?.hamachi.ip) out.push({ kind: "hamachi", label: t("guild.inviteLinkHamachi"), base: `http://${addr.hamachi.ip}:${port}` });
  for (const l of addr?.lan ?? []) out.push({ kind: "lan", label: t("guild.inviteLinkLan", { name: l.name }), base: `http://${l.ip}:${port}` });
  return out.length ? out : [current];
}

export function InviteModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const conn = useStore((st) => st.conn);
  const name = useStore((st) => st.guilds[guildId]?.guild.name ?? "");
  const hostUrl = useStore((st) => st.hostUrl);
  const toast = useStore((st) => st.toast);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<InviteLink[]>([]);

  useEffect(() => {
    conn?.call("invite.create", { guildId, expiresInHours: 24 * 7 }).then((i) => setCode(i.code), (e: Error) => setError(e.message));
  }, [conn, guildId]);

  useEffect(() => {
    if (!hostUrl) return;
    let live = true;
    void inviteLinks(hostUrl).then((l) => { if (live) setLinks(l); });
    return () => { live = false; };
  }, [hostUrl]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast(t("common.copied"));
  };

  return (
    <Modal title={t("guild.inviteTitle", { guild: name })} description={t("guild.inviteDesc")} onClose={onClose}>
      {error ? (
        <div role="alert" style={{ color: "#ff7088" }}>{error}</div>
      ) : !code ? (
        <Spinner />
      ) : (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", height: 48, borderRadius: 10, background: "var(--nx-bg-0)", border: "1px solid var(--nx-line)", font: "700 20px var(--nx-mono)", letterSpacing: ".08em" }}>
              <Icon name="user-plus" size={20} />
              {code}
            </div>
            <Button variant="primary" icon="copy" onClick={() => copy(code)} style={{ height: 48 }}>{t("common.copy")}</Button>
          </div>
          {links.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--nx-text-3)", textTransform: "uppercase", letterSpacing: ".04em" }}>{t("guild.inviteLinks")}</div>
              {links.map((l) => {
                const url = `${l.base}/?invite=${code}`;
                return (
                  <div key={l.base} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 12px", borderRadius: 10, background: "var(--nx-bg-0)", border: "1px solid var(--nx-line)" }}>
                    <Icon name={l.kind === "tunnel" ? "tunnel" : l.kind === "lan" ? "lan" : l.kind === "hamachi" ? "globe" : "link"} size={18} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--nx-text-2)" }}>{l.label}</div>
                      <div style={{ fontSize: 13, fontFamily: "var(--nx-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={url}>{url}</div>
                    </div>
                    <Button icon="copy" onClick={() => copy(url)} aria-label={t("common.copy")}>{t("common.copy")}</Button>
                  </div>
                );
              })}
              {links.some((l) => l.kind === "lan" || l.kind === "hamachi") && (
                <div style={{ fontSize: 12, color: "var(--nx-text-3)" }}>{t("guild.inviteLinksHint")}</div>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
