import { useRef, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { LIMITS, type SelfUser, type UserStatus } from "@nooxcord/shared";
import { t } from "../../i18n";
import { squareWebp } from "../../lib/image";
import { useStore } from "../../state/store";
import { Avatar, Button, Field, IconButton, Modal, cx, useConfirm } from "../../ui";
import s from "./settings.module.css";
import { VoiceTab } from "./VoiceTab";

type Tab = "profile" | "account" | "voice" | "connection";
const STATUSES: { id: UserStatus; color: string }[] = [
  { id: "online", color: "var(--nx-speaking)" },
  { id: "idle", color: "var(--nx-warn)" },
  { id: "dnd", color: "var(--nx-live)" },
  { id: "invisible", color: "var(--nx-text-3)" },
];

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("profile");
  const logout = useStore((st) => st.logout);
  const confirm = useConfirm();

  return (
    <Modal wide onClose={onClose}>
      <nav className={s.nav}>
        <div className={s.navTitle}>{t("settings.title")}</div>
        {(["profile", "account", "voice", "connection"] as const).map((id) => (
          <button key={id} className={cx(s.navItem, tab === id && s.navOn)} onClick={() => setTab(id)}>
            <Icon name={id === "profile" ? "user" : id === "account" ? "lock" : id === "voice" ? "headphones" : "globe"} size={18} />
            <span>{t(`settings.${id}`)}</span>
          </button>
        ))}
        <div className={s.navSep} />
        <button
          className={cx(s.navItem, s.navDanger)}
          onClick={async () => {
            if (await confirm({ title: t("settings.logout"), body: t("settings.logoutDesc"), confirm: t("settings.logout"), danger: true })) void logout();
          }}
        >
          <Icon name="logout" size={18} />
          <span>{t("settings.logout")}</span>
        </button>
      </nav>
      <section className={s.main}>
        <IconButton className={s.close} icon="close" label={t("common.close")} onClick={onClose} />
        {tab === "profile" && <ProfileTab />}
        {tab === "account" && <AccountTab />}
        {tab === "voice" && <VoiceTab />}
        {tab === "connection" && <ConnectionTab />}
      </section>
    </Modal>
  );
}

function ProfileTab() {
  const me = useStore((st) => st.me)!;
  const http = useStore((st) => st.http);
  const conn = useStore((st) => st.conn);
  const setMe = useStore((st) => st.setMe);
  const toast = useStore((st) => st.toast);
  const fileRef = useRef<HTMLInputElement>(null);
  const [nick, setNick] = useState(me.nickname);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function pickAvatar(file: File | undefined) {
    if (!file || !http) return;
    setBusy("avatar");
    try {
      const blob = await squareWebp(file, 256);
      const user = await http.upload<SelfUser>("/api/me/avatar", blob, "avatar.webp").promise;
      setMe(user);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function saveNick() {
    if (!conn || nick.trim() === me.nickname) return;
    setBusy("nick");
    setError(null);
    try {
      setMe(await conn.call("me.update", { nickname: nick.trim() }));
      toast(t("settings.saved"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function setStatus(status: UserStatus) {
    if (!conn) return;
    setMe(await conn.call("me.update", { status }));
  }

  return (
    <>
      <h2 className={s.h}>{t("settings.profile")}</h2>
      <div className={s.row}>
        <div className={s.avatarBox}>
          <Avatar user={me} size={96} />
          <button className={s.avatarEdit} onClick={() => fileRef.current?.click()} aria-label={t("settings.avatarChange")} title={t("settings.avatarChange")}>
            <Icon name="camera" size={16} />
          </button>
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void pickAvatar(e.target.files?.[0])} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Button size="small" variant="primary" icon="upload" loading={busy === "avatar"} onClick={() => fileRef.current?.click()}>{t("settings.avatarChange")}</Button>
          {me.avatar && (
            <Button size="small" variant="ghost" onClick={async () => http && setMe(await http.removeAvatar())}>{t("settings.avatarRemove")}</Button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}>
          <Field label={t("settings.nickname")} value={nick} onChange={(e) => setNick(e.target.value)} maxLength={LIMITS.nicknameMax} error={error} onKeyDown={(e) => e.key === "Enter" && void saveNick()} />
        </div>
        <Button variant="primary" loading={busy === "nick"} disabled={nick.trim() === me.nickname || nick.trim().length < LIMITS.nicknameMin} onClick={() => void saveNick()} style={{ marginBottom: error ? 24 : 0 }}>
          {t("common.save")}
        </Button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ font: "700 11px var(--nx-font)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--nx-text-2)" }}>{t("settings.status")}</span>
        <div className={s.statusGrid} role="radiogroup">
          {STATUSES.map((x) => (
            <button key={x.id} role="radio" aria-checked={me.status === x.id} className={s.statusBtn} onClick={() => void setStatus(x.id)}>
              <span className={s.dot} style={{ background: x.color }} />
              {t(`status.${x.id}`)}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

function AccountTab() {
  const me = useStore((st) => st.me)!;
  return (
    <>
      <h2 className={s.h}>{t("settings.account")}</h2>
      <dl className={s.kv}>
        <dt>{t("auth.nickname")}</dt><dd>{me.nickname}</dd>
        <dt>{t("auth.email")}</dt><dd>{me.email ?? "—"}</dd>
      </dl>
    </>
  );
}

function ConnectionTab() {
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
      <div className={s.note}><Icon name="tunnel" size={18} />{t("settings.tunnelSoon")}</div>
    </>
  );
}
