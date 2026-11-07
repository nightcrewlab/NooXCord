import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@nooxcord/icons";
import { DEFAULT_PORT } from "@nooxcord/shared";
import { t } from "../../i18n";
import { normaliseHostUrl, platform, type LocalHostStatus, type SavedHost } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Field, IconButton } from "../../ui";
import { Welcome, welcomeStyles as s } from "../auth/Welcome";

export function HostPicker() {
  const openHost = useStore((st) => st.openHost);
  const toast = useStore((st) => st.toast);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedHost[]>([]);
  const [local, setLocal] = useState<LocalHostStatus | null>(null);
  const [port, setPort] = useState(String(DEFAULT_PORT));

  useEffect(() => {
    void platform.hosts.list().then(setSaved);
    void platform.localHost?.status().then((st) => {
      setLocal(st);
      if (st.port) setPort(String(st.port));
    });
  }, []);

  async function connect(url: string | null) {
    if (!url) return setError(t("hosts.unreachable"));
    setBusy(url);
    setError(null);
    try {
      await openHost(url);
    } catch {
      setError(t("hosts.unreachable"));
    } finally {
      setBusy(null);
    }
  }

  async function toggleLocal() {
    if (!platform.localHost) return;
    setBusy("local");
    try {
      const st = local?.running ? await platform.localHost.stop() : await platform.localHost.start(Number(port) || DEFAULT_PORT);
      setLocal(st);
      if (st.error) toast(st.error, "error");
      else if (st.running && st.port) await connect(`http://localhost:${st.port}`);
    } finally {
      setBusy(null);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void connect(normaliseHostUrl(addr));
  };

  return (
    <Welcome>
      <h2 className={s.title}>{t("hosts.title")}</h2>
      <p className={s.sub}>{t("hosts.subtitle")}</p>

      <form className={s.form} onSubmit={submit}>
        <Field label={t("hosts.address")} placeholder={`192.168.1.20:${DEFAULT_PORT}`} hint={t("hosts.addressHint")} value={addr} onChange={(e) => setAddr(e.target.value)} autoFocus spellCheck={false} />
        {error && <div className={s.formError} role="alert">{error}</div>}
        <Button type="submit" variant="primary" block loading={busy !== null && busy !== "local" && !saved.some((h) => h.url === busy)} disabled={!addr.trim()}>
          {t("hosts.connect")}
        </Button>
      </form>

      {saved.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>{t("hosts.saved")}</div>
          {saved.map((h) => (
            <div key={h.url} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" className={s.hostRow} onClick={() => void connect(h.url)} disabled={busy !== null}>
                <span className={s.hostIcon}><Icon name={h.url.startsWith("https") ? "globe" : "lan"} size={18} /></span>
                <span className={s.hostMeta}>
                  <div className={s.hostName}>{h.name}</div>
                  <div className={s.hostUrl}>{h.url}</div>
                </span>
                {busy === h.url ? <span className="spin" /> : <Icon name="chevron-right" size={18} />}
              </button>
              <IconButton icon="trash" label={t("hosts.remove")} onClick={async () => { await platform.hosts.remove(h.url); setSaved(await platform.hosts.list()); }} />
            </div>
          ))}
        </div>
      )}

      {platform.localHost && local && (
        <div className={s.local}>
          <div className={s.localHead}>
            <Icon name="server" size={20} />
            <span className={s.localTitle}>{t("hosts.local")}</span>
            <span className={`${s.badge} ${local.running ? s.badgeOn : ""}`}>
              {local.running ? t("hosts.localRunning", { port: local.port ?? "" }) : t("hosts.localStopped")}
            </span>
          </div>
          <div style={{ color: "var(--nx-text-2)", fontSize: 14 }}>{t("hosts.localDesc")}</div>
          <div className={s.localRow}>
            <Field label={t("hosts.port")} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} disabled={local.running} />
            <Button variant={local.running ? "danger" : "secondary"} onClick={() => void toggleLocal()} loading={busy === "local"} icon={local.running ? "close" : "server"}>
              {local.running ? t("hosts.localStop") : t("hosts.localStart")}
            </Button>
          </div>
          {local.running && local.lanAddresses.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionTitle}>{t("hosts.lanAddresses")}</div>
              <div className={s.addrs}>
                {local.lanAddresses.map((a) => (
                  <button key={a} type="button" className={s.addr} title={t("common.copy")} onClick={() => { void navigator.clipboard.writeText(a); toast(t("common.copied")); }}>
                    {a}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Welcome>
  );
}
