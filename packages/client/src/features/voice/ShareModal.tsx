import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { STREAM_PRESETS, type StreamPreset } from "@nooxcord/shared";
import { t } from "../../i18n";
import { voice } from "../../media/engine";
import { useVoiceSettings } from "../../media/settings";
import { platform, type ScreenSource } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Modal, Spinner, cx } from "../../ui";
import s from "./voice.module.css";

const PRESETS = Object.keys(STREAM_PRESETS) as StreamPreset[];

/** Pick a monitor/window (desktop) and a quality preset, then start streaming. */
export function ShareModal({ onClose }: { onClose: () => void }) {
  const settings = useVoiceSettings();
  const toast = useStore((st) => st.toast);
  const desktop = !!platform.media;
  const [sources, setSources] = useState<ScreenSource[] | null>(desktop ? null : []);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!platform.media) return;
    let alive = true;
    const load = () =>
      platform.media!.getSources().then((list) => {
        if (!alive) return;
        setSources(list);
        setPicked((cur) => cur ?? list.find((x) => x.kind === "screen" && x.primary)?.id ?? list[0]?.id ?? null);
      }).catch(() => alive && setSources([]));
    void load();
    const timer = window.setInterval(load, 4000); // windows come and go
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  const list = (sources ?? []).filter((x) => x.kind === tab);
  const source = sources?.find((x) => x.id === picked);
  const bitrate = STREAM_PRESETS[settings.streamPreset].bitrate;

  async function start() {
    setBusy(true);
    try {
      await voice.startScreen({
        preset: settings.streamPreset,
        sourceId: source?.id,
        sourceSize: source?.width && source.height ? { width: source.width, height: source.height, refreshRate: source.refreshRate } : undefined,
        contentHint: settings.contentHint,
        audio: settings.streamAudio,
      });
      onClose();
    } catch (e) {
      const err = e as DOMException;
      if (err.name !== "NotAllowedError" && err.name !== "AbortError") toast(err.message || t("err.streamStart"), "error");
      setBusy(false);
    }
  }

  return (
    <Modal
      medium
      title={t("stream.title")}
      onClose={onClose}
      footer={
        <>
          <span style={{ flex: 1, alignSelf: "center", fontSize: 12, color: "var(--nx-text-3)" }}>{t("stream.bandwidth", { mbps: (bitrate / 1e6).toFixed(1) })}</span>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" icon="screen-share" loading={busy} disabled={desktop && !source} onClick={() => void start()}>{t("stream.start")}</Button>
        </>
      }
    >
      {desktop ? (
        <>
          <div className={s.shareTabs} role="tablist">
            <button role="tab" aria-selected={tab === "screen"} className={cx(s.shareTab, tab === "screen" && s.on)} onClick={() => setTab("screen")}>{t("stream.screens")}</button>
            <button role="tab" aria-selected={tab === "window"} className={cx(s.shareTab, tab === "window" && s.on)} onClick={() => setTab("window")}>{t("stream.windows")}</button>
          </div>
          {sources === null ? (
            <div style={{ display: "grid", placeItems: "center", padding: 32 }}><Spinner /></div>
          ) : list.length === 0 ? (
            <p style={{ color: "var(--nx-text-3)", margin: 0 }}>{t("stream.noSources")}</p>
          ) : (
            <div className={s.sources}>
              {list.map((x) => (
                <button key={x.id} className={cx(s.source, picked === x.id && s.on)} onClick={() => setPicked(x.id)} onDoubleClick={() => { setPicked(x.id); void start(); }}>
                  <img src={x.thumbnail} alt="" draggable={false} />
                  <div className={s.sourceName}>
                    {x.appIcon ? <img src={x.appIcon} alt="" /> : <Icon name={x.kind === "screen" ? "monitor" : "window"} size={16} />}
                    <span>{x.name}</span>
                  </div>
                  {x.kind === "screen" && x.width && (
                    <div className={s.sourceSub}>{x.width}×{x.height}{x.refreshRate ? ` · ${x.refreshRate} Hz` : ""}{x.primary ? ` · ${t("stream.primary")}` : ""}</div>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <p style={{ color: "var(--nx-text-2)", margin: 0 }}>{t("stream.webPicker")}</p>
      )}

      <div>
        <div className={s.sectionTitle}>{t("stream.quality")}</div>
        <div className={s.presets}>
          {PRESETS.map((p) => (
            <button key={p} className={cx(s.preset, settings.streamPreset === p && s.on)} onClick={() => settings.set({ streamPreset: p })}>{t(`stream.preset.${p}`)}</button>
          ))}
        </div>
      </div>

      <div>
        <div className={s.sectionTitle}>{t("stream.hint")}</div>
        <div className={s.presets}>
          {(["motion", "detail"] as const).map((h) => (
            <button key={h} className={cx(s.preset, settings.contentHint === h && s.on)} onClick={() => settings.set({ contentHint: h })}>
              {h === "motion" ? t("stream.hintMotion") : t("stream.hintDetail")}
            </button>
          ))}
        </div>
      </div>

      <label className={s.check}>
        <input type="checkbox" checked={settings.streamAudio} onChange={(e) => settings.set({ streamAudio: e.target.checked })} />
        <span>
          <div>{desktop ? t("stream.audio") : t("stream.audioWeb")}</div>
          {desktop && <div className={s.checkSub}>{t("stream.audioDesc")}</div>}
        </span>
      </label>
    </Modal>
  );
}
