import { useEffect, useMemo, useRef, useState } from "react";
import qrcode from "qrcode-generator";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { platform, type HostPrefs, type LocalHostStatus, type NetAddresses, type PortCheck, type TunnelState } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Field, cx, useConfirm } from "../../ui";
import s from "./settings.module.css";

/** Settings → Connection (CLAUDE.md §10). Host controls are desktop-only. */
export function ConnectionTab() {
  const info = useStore((st) => st.hostInfo);
  const url = useStore((st) => st.hostUrl);
  const status = useStore((st) => st.connStatus);
  return (
    <>
      <h2 className={s.h}>{t("settings.connection")}</h2>
      <dl className={s.kv}>
        <dt>{t("settings.host")}</dt><dd>{info?.name} · {url}</dd>
        <dt>{t("settings.hostVersion")}</dt><dd>{info?.version}</dd>
        <dt>WebSocket</dt><dd>{status}</dd>
      </dl>
      {platform.localHost && platform.net && platform.tunnel && <HostControls />}
    </>
  );
}

function HostControls() {
  const toast = useStore((st) => st.toast);
  const [local, setLocal] = useState<LocalHostStatus | null>(null);
  const [port, setPort] = useState("");
  const [check, setCheck] = useState<PortCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [addr, setAddr] = useState<NetAddresses | null>(null);
  const [prefs, setPrefs] = useState<HostPrefs | null>(null);

  useEffect(() => {
    void platform.localHost!.status().then((st) => { setLocal(st); setPort(String(st.port ?? 47820)); });
    void platform.net!.addresses().then(setAddr);
    void platform.localHost!.getPrefs().then(setPrefs);
  }, []);

  // Live port check while typing (debounced 400 ms, CLAUDE.md §10.1).
  const seq = useRef(0);
  useEffect(() => {
    const n = Number(port);
    if (!port) return setCheck(null);
    const my = ++seq.current;
    setChecking(true);
    const id = setTimeout(() => {
      void platform.net!.checkPort(n).then((c) => { if (my === seq.current) { setCheck(c); setChecking(false); } });
    }, 400);
    return () => clearTimeout(id);
  }, [port, local?.running, local?.port]);

  const portNum = Number(port);
  const canApply = !!check && (check.status === "free") && portNum !== local?.port;

  async function toggleHost() {
    setBusy("host");
    const st = local?.running ? await platform.localHost!.stop() : await platform.localHost!.start(portNum || 47820);
    setLocal(st);
    if (st.error) toast(st.error, "error");
    setBusy(null);
  }

  async function applyPort() {
    setBusy("port");
    const st = await platform.localHost!.restart(portNum);
    setLocal(st);
    if (st.error) toast(st.error, "error");
    else toast(t("net.portApplied", { port: portNum }));
    setBusy(null);
  }

  async function savePrefs(p: Partial<HostPrefs>) {
    if (!prefs) return;
    setPrefs({ ...prefs, ...p });
    await platform.localHost!.setPrefs(p);
  }

  const portMsg = !check ? null
    : check.status === "free" ? (check.mediaFree ? t("net.portFree") : t("net.portFreeMediaBusy", { port: check.port + 1 }))
    : check.status === "own" ? t("net.portOwn")
    : check.status === "in_use" ? t("net.portInUse", { proc: check.process ?? t("net.unknownProcess") })
    : check.status === "privileged" ? t("net.portPrivileged")
    : t("net.portInvalid");
  const portOk = check?.status === "free" || check?.status === "own";

  return (
    <>
      <section className={s.section}>
        <h3 className={s.h3}><Icon name="server" size={18} />{t("net.hostTitle")}</h3>
        <div className={s.perm} style={{ border: "1px solid var(--nx-line)", borderRadius: "var(--nx-radius-m)" }}>
          <span>
            <div>{local?.running ? t("net.hostRunning", { port: local.port ?? "" }) : t("net.hostStopped")}</div>
            <div className={s.hintText}>{t("net.hostDesc")}</div>
          </span>
          <Button size="small" variant={local?.running ? "secondary" : "primary"} loading={busy === "host"} onClick={() => void toggleHost()}>
            {local?.running ? t("net.stopHost") : t("net.startHost")}
          </Button>
        </div>
        <div className={s.portRow}>
          <div style={{ width: 140 }}>
            <Field label={t("net.port")} inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
          </div>
          <Button variant="ghost" icon="refresh" onClick={async () => setPort(String(await platform.net!.suggestPort()))}>{t("net.suggest")}</Button>
          {local?.running && <Button variant="primary" disabled={!canApply} loading={busy === "port"} onClick={() => void applyPort()}>{t("net.applyPort")}</Button>}
        </div>
        {(checking || portMsg) && (
          <div className={cx(s.portStatus, !checking && (portOk ? s.ok : s.bad))}>
            {checking ? t("net.checking") : <><Icon name={portOk ? "check" : "alert"} size={16} />{portMsg}</>}
          </div>
        )}
        <div className={s.hintText}>{t("net.mediaPortHint", { port: (portNum || 47820) + 1 })}</div>
      </section>

      <AddressList addr={addr} port={local?.running ? local.port : null} onAddr={setAddr} />

      {prefs && (
        <section className={s.section}>
          <h3 className={s.h3}><Icon name="users" size={18} />{t("net.guestsTitle")}</h3>
          <div className={s.perms}>
            <div className={s.perm}>
              <span>
                <div>{t("net.allowGuests")}</div>
                <div className={s.hintText}>{t("net.allowGuestsDesc")}</div>
              </span>
              <button role="switch" aria-checked={prefs.allowGuests} aria-label={t("net.allowGuests")} className={s.toggle} onClick={() => void savePrefs({ allowGuests: !prefs.allowGuests })} />
            </div>
          </div>
          <GuestPassword value={prefs.guestPassword} onSave={(v) => void savePrefs({ guestPassword: v }).then(() => toast(t("settings.saved")))} />
        </section>
      )}

      <TunnelSection hostRunning={!!local?.running} prefs={prefs} onPrefs={(p) => void savePrefs(p)} guestPassword={!!prefs?.guestPassword} />
    </>
  );
}

function GuestPassword({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  return (
    <div className={s.portRow}>
      <div style={{ flex: 1 }}>
        <Field label={t("net.guestPassword")} type="password" autoComplete="new-password" value={v} placeholder={t("net.guestPasswordNone")} onChange={(e) => setV(e.target.value)} maxLength={128} />
      </div>
      <Button variant="primary" disabled={v === value} onClick={() => onSave(v)}>{t("common.save")}</Button>
    </div>
  );
}

function AddressList({ addr, port, onAddr }: { addr: NetAddresses | null; port: number | null; onAddr: (a: NetAddresses) => void }) {
  const toast = useStore((st) => st.toast);
  const [busy, setBusy] = useState(false);
  if (!addr) return null;
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast(t("common.copied")));
  const h = addr.hamachi;
  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="lan" size={18} />{t("net.addressesTitle")}</h3>
      <div className={s.perms}>
        {addr.lan.map((a) => (
          <div key={a.ip} className={s.perm}>
            <span><div className={s.mono}>{port ? `http://${a.ip}:${port}` : a.ip}</div><div className={s.hintText}>{a.name}</div></span>
            {port && <Button size="small" variant="ghost" icon="copy" onClick={() => copy(`http://${a.ip}:${port}`)}>{t("common.copy")}</Button>}
          </div>
        ))}
        <div className={s.perm}>
          <span>
            <div>Hamachi {h.ip && <span className={s.mono}>· {port ? `http://${h.ip}:${port}` : h.ip}</span>}</div>
            <div className={s.hintText}>
              {h.service === "missing" ? t("net.hamachiMissing") : h.ip ? t("net.hamachiOn") : h.service === "running" ? t("net.hamachiNoIp") : t("net.hamachiOff")}
            </div>
          </span>
          <div style={{ display: "flex", gap: 6 }}>
            {h.ip && port && <Button size="small" variant="ghost" icon="copy" onClick={() => copy(`http://${h.ip}:${port}`)}>{t("common.copy")}</Button>}
            {h.service === "missing" ? (
              <Button size="small" variant="ghost" icon="external" onClick={() => platform.openExternal("https://vpn.net/")}>{t("net.hamachiDownload")}</Button>
            ) : (h.service === "running" || h.service === "stopped") && (
              <Button size="small" variant="secondary" loading={busy} onClick={async () => {
                setBusy(true);
                onAddr(await platform.net!.hamachiService(h.service !== "running"));
                setBusy(false);
              }}>{h.service === "running" ? t("net.hamachiStop") : t("net.hamachiStart")}</Button>
            )}
          </div>
        </div>
      </div>
      <div className={s.hintText}>{t("net.hamachiHint")}</div>
    </section>
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

function TunnelSection({ hostRunning, prefs, onPrefs, guestPassword }: { hostRunning: boolean; prefs: HostPrefs | null; onPrefs: (p: Partial<HostPrefs>) => void; guestPassword: boolean }) {
  const toast = useStore((st) => st.toast);
  const confirm = useConfirm();
  const [st, setSt] = useState<TunnelState | null>(null);
  const [showLog, setShowLog] = useState(false);
  const tunnel = platform.tunnel!;

  useEffect(() => {
    void tunnel.get().then(setSt);
    return tunnel.onState(setSt);
  }, [tunnel]);
  useEffect(() => {
    if (st?.provider === "devtunnel") void tunnel.devRefresh();
  }, [st?.provider, tunnel]);

  if (!st) return null;
  const on = st.status === "on" || st.status === "starting";
  const dev = st.dev;
  const devReady = st.provider === "cloudflare" || (dev.installed && !!dev.user);
  const run = (fn: () => Promise<unknown>) => void fn().catch((e: Error) => toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), "error"));

  return (
    <section className={s.section}>
      <h3 className={s.h3}><Icon name="tunnel" size={18} />{t("net.tunnelTitle")}</h3>
      <div className={s.segment} role="radiogroup">
        {(["cloudflare", "devtunnel"] as const).map((p) => (
          <button key={p} role="radio" aria-checked={st.provider === p} onClick={() => run(() => tunnel.setProvider(p))}>
            <strong>{t(p === "cloudflare" ? "net.cloudflare" : "net.devtunnel")}</strong>
            <span>{t(p === "cloudflare" ? "net.cloudflareDesc" : "net.devtunnelDesc")}</span>
          </button>
        ))}
      </div>

      {st.provider === "devtunnel" && (
        <div className={s.perms}>
          <div className={s.perm}>
            <span>
              <div>{dev.installed ? (dev.user ? t("net.devLoggedIn", { user: dev.user }) : t("net.devNotLoggedIn")) : t("net.devNotInstalled")}</div>
              {dev.login && <div className={s.hintText}>{t("net.devCode")} <strong className={s.mono}>{dev.login.code}</strong></div>}
            </span>
            {!dev.installed ? (
              <Button size="small" variant="primary" icon="download" loading={dev.busy} onClick={() => run(() => tunnel.devInstall())}>{t("net.devInstall")}</Button>
            ) : dev.user ? (
              <Button size="small" variant="ghost" onClick={() => run(() => tunnel.devLogout())}>{t("net.devLogout")}</Button>
            ) : (
              <Button size="small" variant="primary" loading={dev.busy} onClick={() => run(() => tunnel.devLogin())}>{t("net.devLogin")}</Button>
            )}
          </div>
          {dev.user && (
            <div className={s.perm}>
              <span><div>{t("net.devNewUrl")}</div><div className={s.hintText}>{t("net.devNewUrlDesc")}</div></span>
              <Button size="small" variant="ghost" icon="refresh" onClick={async () => {
                if (await confirm({ title: t("net.devNewUrl"), body: t("net.devNewUrlConfirm"), confirm: t("net.devNewUrlBtn"), danger: true })) run(() => tunnel.devNewUrl());
              }}>{t("net.devNewUrlBtn")}</Button>
            </div>
          )}
          <div className={s.hintText} style={{ padding: "10px 14px" }}>{t("net.devLimits")}</div>
        </div>
      )}

      <div className={s.perm} style={{ border: "1px solid var(--nx-line)", borderRadius: "var(--nx-radius-m)" }}>
        <span>
          <div>{t(`net.tunnel_${st.status}`)}</div>
          {st.error && <div className={s.hintText} style={{ color: "#ff7088" }}>{st.error}</div>}
          {!hostRunning && <div className={s.hintText}>{t("net.tunnelNeedsHost")}</div>}
        </span>
        <button role="switch" aria-checked={on} aria-label={t("net.tunnelTitle")} className={s.toggle} disabled={!hostRunning || !devReady}
          onClick={() => run(() => (on ? tunnel.stop() : tunnel.start()))} />
      </div>

      {st.url && (
        <div className={s.tunnelBox}>
          <Qr text={st.url} />
          <div className={s.tunnelInfo}>
            <div className={s.mono} style={{ wordBreak: "break-all", fontSize: 15 }}>{st.url}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Button size="small" variant="primary" icon="copy" onClick={() => run(async () => { await tunnel.copy(); toast(t("common.copied")); })}>{t("net.copyUrl")}</Button>
              <Button size="small" variant="ghost" icon="external" onClick={() => platform.openExternal(st.url!)}>{t("net.openUrl")}</Button>
            </div>
            <div className={s.hintText}>{t("net.copyShortcut")}</div>
            {st.provider === "cloudflare" && <div className={s.hintText}>{t("net.cloudflareChanges")}</div>}
            {!guestPassword && <div className={s.warnText}><Icon name="alert" size={14} />{t("net.publicWarning")}</div>}
          </div>
        </div>
      )}

      {prefs && (
        <div className={s.perms}>
          <div className={s.perm}>
            <span>{t("net.copyOnChange")}</span>
            <button role="switch" aria-checked={prefs.copyTunnelUrl} aria-label={t("net.copyOnChange")} className={s.toggle} onClick={() => onPrefs({ copyTunnelUrl: !prefs.copyTunnelUrl })} />
          </div>
        </div>
      )}
      <div className={s.hintText}>{t("net.tunnelMediaHint")}</div>
      {st.log.length > 0 && (
        <div>
          <button className={s.linkBtn} onClick={() => setShowLog(!showLog)}>{showLog ? t("net.hideLog") : t("net.showLog")}</button>
          {showLog && <pre className={s.log}>{st.log.join("\n")}</pre>}
        </div>
      )}
    </section>
  );
}
