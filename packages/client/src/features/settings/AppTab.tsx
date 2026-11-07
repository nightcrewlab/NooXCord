import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { getLang, setLang, t, type Lang } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { platform, type AppPrefs, type BackupInfo, type UpdateState } from "../../platform";
import { useStore } from "../../state/store";
import { Button, cx, useConfirm } from "../../ui";
import { ensurePermission, notificationsSupported, useNotify } from "../notify/notify";
import vs from "../voice/voice.module.css";
import s from "./settings.module.css";

/** Settings → App: language, notifications, tray/startup, updates and host backups. */
export function AppTab() {
  return (
    <div>
      <h2 className={s.h}>{t("settings.app")}</h2>
      <Language />
      <Notifications />
      {platform.app && <DesktopPrefs />}
      {platform.updates && <Updates />}
      {platform.backup && <Backups />}
    </div>
  );
}

function Switch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={s.toggle} onClick={onToggle} />;
}

function Language() {
  const cur = getLang();
  const pick = (l: Lang) => {
    if (l === cur) return;
    setLang(l);
    void platform.app?.setPrefs({ lang: l }).finally(() => location.reload());
    if (!platform.app) location.reload();
  };
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="globe" size={18} />{t("settings.language")}</h3>
      <div className={vs.presets}>
        {(["tr", "en"] as const).map((l) => (
          <button key={l} className={cx(vs.preset, cur === l && vs.on)} onClick={() => pick(l)}>{l === "tr" ? t("lang.tr") : t("lang.en")}</button>
        ))}
      </div>
    </section>
  );
}

function Notifications() {
  const n = useNotify();
  const toast = useStore((st) => st.toast);
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="bell" size={18} />{t("notify.title")}</h3>
      <div className={s.perms}>
        <div className={s.perm}>
          <span>{t("notify.desktop")}<div className={s.hintText}>{t("notify.desktopDesc")}</div></span>
          <Switch on={n.enabled} label={t("notify.desktop")} onToggle={() => {
            const next = !n.enabled;
            n.set({ enabled: next });
            if (next && notificationsSupported()) void ensurePermission().then((ok) => !ok && toast(t("notify.permissionDenied"), "error"));
          }} />
        </div>
        <div className={s.perm}>
          <span>{t("notify.sound")}</span>
          <Switch on={n.sound} label={t("notify.sound")} onToggle={() => n.set({ sound: !n.sound })} />
        </div>
      </div>
      <div className={s.hintText}>{t("notify.dndNote")}</div>
    </section>
  );
}

function DesktopPrefs() {
  const [p, setP] = useState<AppPrefs | null>(null);
  useEffect(() => { void platform.app!.getPrefs().then(setP); }, []);
  if (!p) return null;
  const save = (x: Partial<AppPrefs>) => void platform.app!.setPrefs(x).then(setP);
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="settings" size={18} />NooXCord</h3>
      <div className={s.perms}>
        <div className={s.perm}>
          <span>{t("settings.closeToTray")}<div className={s.hintText}>{t("settings.closeToTrayDesc")}</div></span>
          <Switch on={p.closeToTray} label={t("settings.closeToTray")} onToggle={() => save({ closeToTray: !p.closeToTray })} />
        </div>
        <div className={s.perm}>
          <span>{t("settings.openAtLogin")}{!p.canOpenAtLogin && <div className={s.hintText}>{t("settings.openAtLoginDev")}</div>}</span>
          <Switch on={p.openAtLogin} disabled={!p.canOpenAtLogin} label={t("settings.openAtLogin")} onToggle={() => save({ openAtLogin: !p.openAtLogin })} />
        </div>
      </div>
      <Button size="small" variant="ghost" icon="file" onClick={() => void platform.app!.openLogs()}>{t("settings.logs")}</Button>
    </section>
  );
}

function updateText(u: UpdateState): string {
  switch (u.status) {
    case "dev": return t("update.devOnly");
    case "checking": return t("update.checking");
    case "none": return t("update.none", { version: u.current });
    case "downloading": return t("update.downloading", { version: u.version ?? "", pct: Math.round(u.pct ?? 0) });
    case "ready": return t("update.ready", { version: u.version ?? "" });
    case "error": return t("update.error", { msg: u.error ?? "" });
    default: return t("update.none", { version: u.current });
  }
}

function Updates() {
  const [u, setU] = useState<UpdateState | null>(null);
  useEffect(() => {
    void platform.updates!.get().then(setU);
    return platform.updates!.onState(setU);
  }, []);
  if (!u) return null;
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="download" size={18} />{t("update.title")}</h3>
      <div className={s.perm} style={{ border: "1px solid var(--nx-line)", borderRadius: "var(--nx-radius-m)" }}>
        <span className={s.hintText} style={{ marginTop: 0 }}>{updateText(u)}</span>
        {u.status === "ready"
          ? <Button size="small" variant="primary" onClick={() => void platform.updates!.install()}>{t("update.restart")}</Button>
          : <Button size="small" variant="secondary" disabled={u.status === "dev" || u.status === "checking" || u.status === "downloading"} loading={u.status === "checking"} onClick={() => void platform.updates!.check().then(setU)}>{t("update.check")}</Button>}
      </div>
    </section>
  );
}

function Backups() {
  const [list, setList] = useState<BackupInfo[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useStore((st) => st.toast);
  const confirm = useConfirm();
  const b = platform.backup!;
  const reload = () => void b.list().then(setList);
  useEffect(reload, [b]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r !== false) toast(ok);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
      reload();
    }
  };
  const restore = async (fn: () => Promise<boolean>) => {
    if (!(await confirm({ title: t("backup.restore"), body: t("backup.importConfirm"), confirm: t("backup.restore"), danger: true }))) return;
    await run(fn, t("backup.imported"));
  };
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="server" size={18} />{t("backup.title")}</h3>
      <div className={s.hintText}>{t("backup.desc")}</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "10px 0" }}>
        <Button size="small" variant="primary" loading={busy} onClick={() => void run(() => b.now(), t("backup.done"))}>{t("backup.now")}</Button>
        <Button size="small" variant="secondary" disabled={busy} onClick={() => void run(() => b.export(), t("backup.exported"))}>{t("backup.export")}</Button>
        <Button size="small" variant="secondary" disabled={busy} onClick={() => void restore(() => b.import())}>{t("backup.import")}</Button>
        <Button size="small" variant="ghost" icon="external" onClick={() => void b.openFolder()}>{t("backup.openFolder")}</Button>
      </div>
      <div className={s.perms}>
        {list && list.length === 0 && <div className={s.perm}><span className={s.hintText}>{t("backup.none")}</span></div>}
        {list?.map((x) => (
          <div key={x.name} className={s.perm}>
            <span><div className={s.mono}>{new Date(x.at).toLocaleString(getLang() === "tr" ? "tr-TR" : "en-GB")}</div><div className={s.hintText}>{x.name} · {formatBytes(x.size)}</div></span>
            <Button size="small" variant="ghost" disabled={busy} onClick={() => void restore(() => b.restore(x.name).then(() => true))}>{t("backup.restore")}</Button>
          </div>
        ))}
      </div>
    </section>
  );
}
