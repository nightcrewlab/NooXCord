import { useState, type FormEvent } from "react";
import { Icon } from "@nooxcord/icons";
import { LIMITS } from "@nooxcord/shared";
import { t } from "../../i18n";
import { RpcError } from "../../net/connection";
import { platform } from "../../platform";
import { useStore } from "../../state/store";
import { Button, Field } from "../../ui";
import { Welcome, welcomeStyles as s } from "./Welcome";

export function AuthScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ login: "", nickname: "", email: "", password: "" });
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
      const res = mode === "login" ? await http.login(form.login, form.password) : await http.register(form.nickname, form.email, form.password);
      await authenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof RpcError ? err.message : t("common.error"));
    } finally {
      setBusy(false);
    }
  }

  const isLogin = mode === "login";
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
    </Welcome>
  );
}
