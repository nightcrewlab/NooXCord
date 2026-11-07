import { useState, type FormEvent } from "react";
import { Icon } from "@nooxcord/icons";
import { LIMITS } from "@nooxcord/shared";
import { t } from "../../i18n";
import { RpcError } from "../../net/connection";
import { appJoinLink, platform } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Field } from "../../ui";
import { Welcome, welcomeStyles as s } from "./Welcome";

/** Web (PC browser): open this host in the installed desktop app instead, tunnels included. */
function OpenInApp() {
  if (platform.kind !== "web" || platform.isMobile) return null;
  const invite = new URLSearchParams(location.search).get("invite");
  return (
    <div className={s.switch}>
      {t("auth.haveApp")}
      <button type="button" onClick={() => { location.href = appJoinLink(location.origin, invite); }}>{t("auth.openInApp")}</button>
    </div>
  );
}

export function AuthScreen() {
  const hostInfo0 = useStore((st) => st.hostInfo);
  // Browsers join as guests by default (CLAUDE.md §5.2); accounts are for the desktop app.
  const [mode, setMode] = useState<"login" | "register" | "guest">(platform.kind === "web" && hostInfo0?.allowGuests !== false ? "guest" : "login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ login: "", nickname: "", email: "", password: "", guestPassword: "" });
  const http = useStore((st) => st.http);
  const hostInfo = useStore((st) => st.hostInfo);
  const authenticated = useStore((st) => st.authenticated);
  const leaveHost = useStore((st) => st.leaveHost);
  const upd = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!http) return;
    setBusy(true);
    setError(null);
    try {
      const res =
        mode === "guest" ? await http.guest(form.nickname.trim(), form.guestPassword || undefined)
        : mode === "login" ? await http.login(form.login, form.password)
        : await http.register(form.nickname, form.email, form.password);
      await authenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof RpcError ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === "login";
  if (mode === "guest") {
    return (
      <Welcome>
        <h2 className={s.title}>{t("auth.guestTitle")}</h2>
        <p className={s.sub}>{t("auth.guestSub", { host: hostInfo?.name ?? "" })}</p>
        <form className={s.form} onSubmit={submit} noValidate>
          <Field label={t("auth.nickname")} autoComplete="nickname" value={form.nickname} onChange={upd("nickname")} minLength={LIMITS.nicknameMin} maxLength={LIMITS.nicknameMax} required autoFocus hint={t("auth.guestHint")} />
          {hostInfo?.guestPassword && (
            <Field label={t("auth.guestPassword")} type="password" autoComplete="current-password" value={form.guestPassword} onChange={upd("guestPassword")} required />
          )}
          {error && <div className={s.formError} role="alert">{error}</div>}
          <Button type="submit" variant="primary" block loading={busy} disabled={form.nickname.trim().length < LIMITS.nicknameMin}>
            {t("auth.guestJoin")}
          </Button>
        </form>
        <div className={s.switch}>
          {t("auth.haveAccount")}
          <button type="button" onClick={() => { setMode("login"); setError(null); }}>{t("auth.login")}</button>
        </div>
        <OpenInApp />
      </Welcome>
    );
  }
  return (
    <Welcome>
      {!platform.fixedHost && (
        <button type="button" className={s.hostChip} onClick={() => void leaveHost()} title={t("hosts.switch")}>
          <Icon name="server" size={14} />
          {t("auth.on", { host: hostInfo?.name ?? http?.base ?? "" })}
          <Icon name="chevron-down" size={14} />
        </button>
      )}
      <h2 className={s.title}>{isLogin ? t("auth.loginTitle") : t("auth.registerTitle")}</h2>
      <p className={s.sub}>{t("auth.remember")}</p>
      <form className={s.form} onSubmit={submit} noValidate>
        {isLogin ? (
          <Field label={t("auth.loginField")} autoComplete="username" value={form.login} onChange={upd("login")} required autoFocus />
        ) : (
          <>
            <Field label={t("auth.nickname")} autoComplete="nickname" value={form.nickname} onChange={upd("nickname")} minLength={LIMITS.nicknameMin} maxLength={LIMITS.nicknameMax} required autoFocus />
            <Field label={t("auth.email")} type="email" autoComplete="email" value={form.email} onChange={upd("email")} required />
          </>
        )}
        <Field
          label={t("auth.password")}
          type="password"
          autoComplete={isLogin ? "current-password" : "new-password"}
          value={form.password}
          onChange={upd("password")}
          hint={isLogin ? undefined : t("auth.passwordHint")}
          required
        />
        {error && <div className={s.formError} role="alert">{error}</div>}
        <Button type="submit" variant="primary" block loading={busy}>
          {isLogin ? t("auth.login") : t("auth.register")}
        </Button>
      </form>
      <div className={s.switch}>
        {isLogin ? t("auth.noAccount") : t("auth.haveAccount")}
        <button type="button" onClick={() => { setMode(isLogin ? "register" : "login"); setError(null); }}>
          {isLogin ? t("auth.register") : t("auth.login")}
        </button>
      </div>
      {platform.kind === "web" && hostInfo?.allowGuests && (
        <div className={s.switch}>
          <button type="button" onClick={() => { setMode("guest"); setError(null); }}>{t("auth.asGuest")}</button>
        </div>
      )}
      <OpenInApp />
    </Welcome>
  );
}
