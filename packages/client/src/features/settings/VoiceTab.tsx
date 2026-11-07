import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { VadGate, meter, type LevelMeter } from "../../media/level";
import { useVoice, voice } from "../../media/engine";
import { useVoiceSettings, type VoiceSettings } from "../../media/settings";
import { platform } from "../../platform";
import { Button, cx } from "../../ui";
import vs from "../voice/voice.module.css";
import s from "./settings.module.css";

const MIN_DB = -80;
const pct = (db: number) => Math.max(0, Math.min(100, ((db - MIN_DB) / -MIN_DB) * 100));

/** Pretty name for a KeyboardEvent.code. */
function keyName(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code.replace(/^(Arrow|Numpad)/, "$1 ").replace("Left", ` ${t("key.left")}`).replace("Right", ` ${t("key.right")}`);
}

export function VoiceTab() {
  const st = useVoiceSettings();
  const inCall = useVoice((v) => !!v.channelId);
  const callLevel = useVoice((v) => v.micLevel);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [testLevel, setTestLevel] = useState<number | null>(null);
  const [capturing, setCapturing] = useState(false);
  const test = useRef<{ stream: MediaStream; meter: LevelMeter | null } | null>(null);
  const gate = useRef(new VadGate());
  const [autoTh, setAutoTh] = useState(-50);

  useEffect(() => {
    const load = () => navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => {});
    load();
    navigator.mediaDevices?.addEventListener("devicechange", load);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", load);
  }, []);

  useEffect(() => () => stopTest(), []);

  async function startTest() {
    stopTest();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: st.inputDeviceId ? { exact: st.inputDeviceId } : undefined, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl },
      });
      test.current = { stream, meter: null };
      test.current.meter = await meter(stream.getAudioTracks()[0]!, (db) => {
        gate.current.update(db, useVoiceSettings.getState().vadThreshold);
        setTestLevel(db);
        setAutoTh(gate.current.autoThreshold);
      });
      navigator.mediaDevices.enumerateDevices().then(setDevices).catch(() => {});
    } catch {
      setTestLevel(null);
    }
  }

  function stopTest() {
    test.current?.meter?.stop();
    test.current?.stream.getTracks().forEach((x) => x.stop());
    test.current = null;
    setTestLevel(null);
  }

  /** Changing capture options re-opens the call microphone. */
  function setAndRestart(p: Partial<VoiceSettings>) {
    st.set(p);
    if (inCall) void voice.restartMic();
    if (test.current) void startTest();
  }

  const inputs = devices.filter((d) => d.kind === "audioinput");
  const outputs = devices.filter((d) => d.kind === "audiooutput");
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);
  const level = testLevel ?? (inCall ? callLevel : null);
  const threshold = st.vadThreshold ?? (inCall && testLevel === null ? voice.vadThreshold() : autoTh);

  return (
    <>
      <h2 className={s.h}>{t("settings.voice")}</h2>

      <div className={s.grid2}>
        <label className={s.selectField}>
          <span className={s.label}>{t("settings.input")}</span>
          <select className={s.select} value={st.inputDeviceId} onChange={(e) => setAndRestart({ inputDeviceId: e.target.value })}>
            <option value="">{t("settings.default")}</option>
            {inputs.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Mikrofon ${i + 1}`}</option>)}
          </select>
        </label>
        <label className={s.selectField}>
          <span className={s.label}>{t("settings.output")}</span>
          <select className={s.select} value={st.outputDeviceId} onChange={(e) => { st.set({ outputDeviceId: e.target.value }); void voice.setOutputDevice(e.target.value); }}>
            <option value="">{t("settings.default")}</option>
            {outputs.filter((d) => d.deviceId && d.deviceId !== "default").map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || t("settings.speakerN", { n: i + 1 })}</option>)}
          </select>
        </label>
      </div>
      {unnamed && <div className={s.hintText}>{t("settings.devicesHint")}</div>}

      <div>
        <div className={s.label} style={{ marginBottom: 8 }}>{t("settings.inputMode")}</div>
        <div className={vs.presets}>
          <button className={cx(vs.preset, st.mode === "vad" && vs.on)} onClick={() => st.set({ mode: "vad" })}>{t("settings.vad")}</button>
          <button className={cx(vs.preset, st.mode === "ptt" && vs.on)} onClick={() => st.set({ mode: "ptt" })}>{t("settings.ptt")}</button>
        </div>
      </div>

      {st.mode === "ptt" ? (
        <div>
          <div className={s.label} style={{ marginBottom: 8 }}>{t("settings.pttKey")}</div>
          <div className={s.row} style={{ gap: 12 }}>
            <Button variant="secondary" onClick={() => setCapturing(true)} onKeyDown={(e) => {
              if (!capturing) return;
              e.preventDefault();
              st.set({ pttKey: e.code });
              setCapturing(false);
            }} onBlur={() => setCapturing(false)}>
              {capturing ? t("settings.pttPress") : keyName(st.pttKey)}
            </Button>
            {platform.media && <span className={s.hintText}>{t("settings.pttHint")}</span>}
          </div>
        </div>
      ) : (
        <div>
          <div className={s.row} style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <span className={s.label}>{t("settings.sensitivity")}</span>
            <label className={s.row} style={{ gap: 8, fontSize: 13 }}>
              {t("settings.sensitivityAuto")}
              <button role="switch" aria-checked={st.vadThreshold === null} className={s.toggle} onClick={() => st.set({ vadThreshold: st.vadThreshold === null ? Math.round(threshold) : null })} />
            </label>
          </div>
          <div className={s.meter}>
            <div className={s.meterFill} style={{ width: `${level === null ? 0 : pct(level)}%`, background: level !== null && level > threshold ? "var(--nx-speaking)" : "var(--nx-text-3)" }} />
            <div className={s.meterMark} style={{ left: `${pct(threshold)}%` }} />
            {st.vadThreshold !== null && (
              <input className={s.meterRange} type="range" min={MIN_DB} max={0} step={1} value={st.vadThreshold} aria-label={t("settings.sensitivity")}
                onChange={(e) => st.set({ vadThreshold: Number(e.target.value) })} />
            )}
          </div>
        </div>
      )}

      <div className={s.row} style={{ gap: 12 }}>
        {testLevel === null
          ? <Button variant="secondary" icon="mic" onClick={() => void startTest()}>{t("settings.micTestStart")}</Button>
          : <Button variant="secondary" icon="mic-off" onClick={stopTest}>{t("settings.micTestStop")}</Button>}
      </div>

      <div>
        <div className={s.label} style={{ marginBottom: 8 }}>{t("settings.processing")}</div>
        <div className={s.perms}>
          {([["echoCancellation", "settings.echo"], ["noiseSuppression", "settings.noise"], ["autoGainControl", "settings.agc"]] as const).map(([k, label]) => (
            <div key={k} className={s.perm}>
              <span>{t(label)}</span>
              <button role="switch" aria-checked={st[k]} aria-label={t(label)} className={s.toggle} onClick={() => setAndRestart({ [k]: !st[k] })} />
            </div>
          ))}
          {platform.overlay && (
            <div className={s.perm}>
              <span>
                <div>{t("settings.overlay")}</div>
                <div className={s.hintText}>{t("settings.overlayDesc")}</div>
              </span>
              <button role="switch" aria-checked={st.overlay} aria-label={t("settings.overlay")} className={s.toggle} onClick={() => st.set({ overlay: !st.overlay })} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
