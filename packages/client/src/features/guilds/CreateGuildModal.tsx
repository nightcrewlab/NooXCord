import { useState, type FormEvent } from "react";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Button, Field, Modal } from "../../ui";

/** Create a new guild, or join one with an invite code (accepts a full link too). Guests can only join. */
export function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const conn = useStore((st) => st.conn);
  const me = useStore((st) => st.me);
  const selectGuild = useStore((st) => st.selectGuild);
  const [name, setName] = useState(me ? `${me.nickname} sunucusu` : "");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<"create" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guest = !!me?.guest;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!conn || !name.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const gs = await conn.call("guild.create", { name: name.trim() });
      selectGuild(gs.guild.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function join(e: FormEvent) {
    e.preventDefault();
    const c = code.trim().split(/[/=]/).pop() ?? "";
    if (!conn || !c) return;
    setBusy("join");
    setError(null);
    try {
      const gs = await conn.call("invite.join", { code: c });
      selectGuild(gs.guild.id);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={guest ? t("guild.joinTitle") : t("guild.createTitle")} description={guest ? t("guild.joinGuestDesc") : t("guild.createDesc")} onClose={onClose}>
      {!guest && <>
      <form onSubmit={create} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Field label={t("guild.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></div>
        <Button type="submit" variant="primary" loading={busy === "create"} disabled={!name.trim()}>{t("common.create")}</Button>
      </form>
      <div style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--nx-text-3)", fontSize: 12, textTransform: "uppercase", letterSpacing: ".06em" }}>
        <span style={{ flex: 1, height: 1, background: "var(--nx-line)" }} />{t("guild.or")}<span style={{ flex: 1, height: 1, background: "var(--nx-line)" }} />
      </div>
      </>}
      <form onSubmit={join} style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <div style={{ flex: 1 }}><Field label={t("guild.inviteCode")} placeholder="aB3dE5fG" value={code} onChange={(e) => setCode(e.target.value)} spellCheck={false} hint={t("guild.joinDesc")} /></div>
        <Button type="submit" loading={busy === "join"} disabled={!code.trim()} style={{ marginBottom: 22 }}>{t("guild.join")}</Button>
      </form>
      {error && <div role="alert" style={{ color: "#ff7088", fontSize: 14 }}>{error}</div>}
    </Modal>
  );
}
