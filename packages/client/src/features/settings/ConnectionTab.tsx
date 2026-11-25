import { useMemo } from "react";
import qrcode from "qrcode-generator";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import s from "./settings.module.css";

/** Settings → Connection: the server this client uses, and a QR code to open it on a phone. */
export function ConnectionTab() {
  const info = useStore((st) => st.hostInfo);
  const url = useStore((st) => st.hostUrl);
  const status = useStore((st) => st.connStatus);
  const ping = useStore((st) => st.ping);
  return (
    <>
      <h2 className={s.h}>{t("settings.connection")}</h2>
      <dl className={s.kv}>
        <dt>{t("settings.host")}</dt><dd>{info?.name} · {url}</dd>
        <dt>{t("settings.hostVersion")}</dt><dd>{info?.version}</dd>
        <dt>WebSocket</dt><dd>{status}</dd>
        <dt>{t("settings.ping")}</dt><dd>{ping === null ? "…" : t("stats.ms", { n: ping })}</dd>
      </dl>
      {url && (
        <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 16 }}>
          <Qr text={url} />
          <p style={{ margin: 0, color: "var(--nx-text-2)", fontSize: 13 }}>{t("net.qrHint")}</p>
        </div>
      )}
    </>
  );
}

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div className={s.qr} dangerouslySetInnerHTML={{ __html: svg }} aria-label={t("net.qr")} role="img" />;
}
