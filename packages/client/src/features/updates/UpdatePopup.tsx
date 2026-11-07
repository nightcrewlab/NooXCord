import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { platform, type UpdateState } from "../../platform";
import { Button, IconButton } from "../../ui";
import s from "./updates.module.css";

/**
 * Corner card for auto-update (desktop, installed app): download progress, then "restart and install".
 * Closing it hides that phase only; the "ready" card comes back once the download finishes.
 */
export function UpdatePopup() {
  const [u, setU] = useState<UpdateState | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);

  useEffect(() => {
    const up = platform.updates;
    if (!up) return;
    void up.get().then(setU).catch(() => {});
    return up.onState(setU);
  }, []);

  if (!u || (u.status !== "downloading" && u.status !== "ready")) return null;
  const phase = `${u.status}:${u.version ?? ""}`;
  if (hidden === phase) return null;
  const pct = Math.max(0, Math.min(100, Math.round(u.pct ?? 0)));

  return (
    <div className={s.popup} role="status" aria-live="polite">
      <div className={s.head}>
        <Icon name="download" size={18} />
        <div className={s.title}>
          {u.status === "ready" ? t("update.popupReady", { version: u.version ?? "" }) : t("update.popupDownloading", { version: u.version ?? "" })}
        </div>
        <IconButton icon="close" size={16} label={t("common.close")} onClick={() => setHidden(phase)} />
      </div>
      {u.status === "downloading" ? (
        <>
          <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className={s.fill} style={{ width: `${pct}%` }} />
          </div>
          <div className={s.sub}>{t("update.pct", { pct })}</div>
        </>
      ) : (
        <>
          <div className={s.sub}>{t("update.popupReadyDesc")}</div>
          <div className={s.actions}>
            <Button size="small" variant="ghost" onClick={() => setHidden(phase)}>{t("update.later")}</Button>
            <Button size="small" variant="primary" onClick={() => void platform.updates?.install()}>{t("update.restart")}</Button>
          </div>
        </>
      )}
    </div>
  );
}
