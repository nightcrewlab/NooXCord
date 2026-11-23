import { useEffect, useState, type FormEvent } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { DEFAULT_HOST, normaliseHostUrl, platform, type SavedHost } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Field, IconButton } from "../../ui";
import { Welcome, welcomeStyles as s } from "../auth/Welcome";

export function HostPicker() {
  const openHost = useStore((st) => st.openHost);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedHost[]>([]);

  useEffect(() => {
    void platform.hosts.list().then(setSaved);
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

  // The built-in server first, then the ones added by hand.
  const hosts: SavedHost[] = DEFAULT_HOST && !saved.some((h) => h.url === DEFAULT_HOST) ? [{ url: DEFAULT_HOST, name: "NooXCord" }, ...saved] : saved;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void connect(normaliseHostUrl(addr));
  };

  return (
    <Welcome>
      <h2 className={s.title}>{t("hosts.title")}</h2>
      <p className={s.sub}>{t("hosts.subtitle")}</p>

      <form className={s.form} onSubmit={submit}>
        <Field label={t("hosts.address")} placeholder="nooxcord.onrender.com" hint={t("hosts.addressHint")} value={addr} onChange={(e) => setAddr(e.target.value)} autoFocus spellCheck={false} />
        {error && <div className={s.formError} role="alert">{error}</div>}
        <Button type="submit" variant="primary" block loading={busy !== null && !hosts.some((h) => h.url === busy)} disabled={!addr.trim()}>
          {t("hosts.connect")}
        </Button>
      </form>

      {hosts.length > 0 && (
        <div className={s.section}>
          <div className={s.sectionTitle}>{t("hosts.saved")}</div>
          {hosts.map((h) => (
            <div key={h.url} style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button type="button" className={s.hostRow} onClick={() => void connect(h.url)} disabled={busy !== null}>
                <span className={s.hostIcon}><Icon name={h.url.startsWith("https") ? "globe" : "lan"} size={18} /></span>
                <span className={s.hostMeta}>
                  <div className={s.hostName}>{h.name}</div>
                  <div className={s.hostUrl}>{h.url}</div>
                </span>
                {busy === h.url ? <span className="spin" /> : <Icon name="chevron-right" size={18} />}
              </button>
              {saved.some((x) => x.url === h.url) && <IconButton icon="trash" label={t("hosts.remove")} onClick={async () => { await platform.hosts.remove(h.url); setSaved(await platform.hosts.list()); }} />}
            </div>
          ))}
        </div>
      )}

    </Welcome>
  );
}
