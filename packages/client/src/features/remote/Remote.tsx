import { useEffect, useRef, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { remote, useRemote } from "../../media/remote";
import { useStore } from "../../state/store";
import { Avatar, Button } from "../../ui";
import s from "./remote.module.css";

/** Where the video content actually is inside a letterboxed <video> (object-fit: contain). */
function contentRect(video: HTMLVideoElement): DOMRect {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return r;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale;
  return new DOMRect(r.left + (r.width - w) / 2, r.top + (r.height - h) / 2, w, h);
}

/**
 * Transparent layer over a stream we control: captures pointer, wheel and keyboard and sends them
 * (normalised to the video content) to the streamer. Keys are only captured while the layer has focus.
 */
export function RemoteSurface({ tileRef }: { tileRef: React.RefObject<HTMLDivElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  const keys = useRef(new Set<string>());
  const buttons = useRef(new Set<number>());
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    ref.current?.focus();
    const releaseAll = () => {
      for (const c of keys.current) remote.send({ k: "k", c, d: false });
      for (const b of buttons.current) remote.send({ k: "b", b, d: false });
      keys.current.clear();
      buttons.current.clear();
    };
    window.addEventListener("blur", releaseAll);
    return () => {
      window.removeEventListener("blur", releaseAll);
      releaseAll();
    };
  }, []);

  const pos = (e: React.PointerEvent | React.MouseEvent) => {
    const video = tileRef.current?.querySelector("video");
    if (!video) return null;
    const r = contentRect(video);
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
  };

  const releaseKeys = () => {
    for (const c of keys.current) remote.send({ k: "k", c, d: false });
    keys.current.clear();
  };

  return (
    <div
      ref={ref}
      className={s.surface}
      tabIndex={0}
      aria-label={t("remote.clickToControl")}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); releaseKeys(); }}
      onPointerMove={(e) => {
        const p = pos(e);
        if (p) remote.send({ k: "m", ...p });
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.setPointerCapture(e.pointerId);
        const p = pos(e);
        if (!p || e.button < 0 || e.button > 4) return;
        remote.send({ k: "m", ...p });
        buttons.current.add(e.button);
        remote.send({ k: "b", b: e.button, d: true });
      }}
      onPointerUp={(e) => {
        if (!buttons.current.delete(e.button)) return;
        remote.send({ k: "b", b: e.button, d: false });
      }}
      onContextMenu={(e) => e.preventDefault()}
      onWheel={(e) => {
        const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1.2;
        const clamp = (v: number) => Math.max(-2400, Math.min(2400, Math.round(v)));
        const dy = clamp(-e.deltaY * k), dx = clamp(e.deltaX * k);
        if (dx || dy) remote.send({ k: "w", dx, dy });
      }}
      onKeyDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!/^[A-Za-z0-9]{1,24}$/.test(e.code)) return; // repeats are sent too: injected keys do not auto-repeat
        keys.current.add(e.code);
        remote.send({ k: "k", c: e.code, d: true });
      }}
      onKeyUp={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!keys.current.delete(e.code)) return;
        remote.send({ k: "k", c: e.code, d: false });
      }}
    >
      {!focused && <div className={s.surfaceHint}><Icon name="pointer" size={16} />{t("remote.clickToControl")}</div>}
    </div>
  );
}

/** Streamer: pending control requests. Viewer/streamer: who controls what right now. */
export function RemoteLayer() {
  const r = useRemote();
  const users = useStore((st) => st.users);
  if (!r.requests.length && !r.controlledBy && !r.controlling) return null;
  return (
    <div className={s.layer} role="region" aria-live="polite">
      {r.requests.map((id) => {
        const u = users[id];
        return (
          <div key={id} className={s.card}>
            <div className={s.cardHead}>
              {u && <Avatar user={u} size={32} />}
              <div className={s.cardText}>{t("remote.incoming", { user: u?.nickname ?? "?" })}</div>
            </div>
            <div className={s.note}>{t("remote.uacNote")}</div>
            <div className={s.actions}>
              <Button size="small" variant="primary" onClick={() => void remote.respond(id, true)}>{t("remote.accept")}</Button>
              <Button size="small" variant="secondary" onClick={() => void remote.respond(id, true, true)}>{t("remote.always")}</Button>
              <Button size="small" variant="danger" onClick={() => void remote.respond(id, false)}>{t("remote.deny")}</Button>
            </div>
          </div>
        );
      })}
      {r.controlledBy && (
        <div className={s.bar}>
          <Icon name="pointer" size={18} />
          <div className={s.barText}>
            <b>{t("remote.controlledBy", { user: users[r.controlledBy]?.nickname ?? "?" })}</b>
            <span>{t("remote.panicHint")}</span>
          </div>
          <Button size="small" variant="danger" onClick={() => void remote.revoke()}>{t("remote.revoke")}</Button>
        </div>
      )}
      {r.controlling && (
        <div className={s.bar}>
          <Icon name="pointer" size={18} />
          <div className={s.barText}>
            <b>{t("remote.controlling", { user: users[r.controlling]?.nickname ?? "?" })}</b>
            <span>{t("remote.controllingHint")}</span>
          </div>
          <Button size="small" variant="secondary" onClick={() => void remote.release()}>{t("remote.release")}</Button>
        </div>
      )}
    </div>
  );
}
