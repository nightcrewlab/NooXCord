import { useEffect, useRef, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { P, has, type Guild, type PermissionName, type Role } from "@nooxcord/shared";
import { t, type I18nKey } from "../../i18n";
import { initials } from "../../lib/format";
import { squareWebp } from "../../lib/image";
import { useStore } from "../../state/store";
import { Button, Field, IconButton, Modal, cx, useConfirm } from "../../ui";
import s from "../settings/settings.module.css";

const ROLE_COLORS = ["#FF7A45", "#FFB347", "#F5C451", "#3DDC84", "#5CE1E6", "#4CC9F0", "#B388FF", "#FF5C8A", "#9AA3B2"];
const PERM_ORDER: PermissionName[] = [
  "ADMINISTRATOR", "MANAGE_GUILD", "MANAGE_ROLES", "MANAGE_CHANNELS", "MANAGE_MESSAGES", "KICK_MEMBERS", "BAN_MEMBERS", "CREATE_INVITES",
  "VIEW_CHANNELS", "SEND_MESSAGES", "ATTACH_FILES", "CONNECT_VOICE", "SPEAK", "STREAM", "VIDEO", "REQUEST_REMOTE_CONTROL",
];

export function GuildSettingsModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const gs = useStore((st) => st.guilds[guildId]);
  const [tab, setTab] = useState<"overview" | "roles">(gs && has(gs.myPerms, P.MANAGE_GUILD) ? "overview" : "roles");
  useEffect(() => { if (!gs) onClose(); }, [gs, onClose]);
  if (!gs) return null;
  return (
    <Modal wide onClose={onClose}>
      <nav className={s.nav}>
        <div className={s.navTitle}>{gs.guild.name}</div>
        {has(gs.myPerms, P.MANAGE_GUILD) && (
          <button className={cx(s.navItem, tab === "overview" && s.navOn)} onClick={() => setTab("overview")}><Icon name="settings" size={18} /><span>{t("guild.overview")}</span></button>
        )}
        {has(gs.myPerms, P.MANAGE_ROLES) && (
          <button className={cx(s.navItem, tab === "roles" && s.navOn)} onClick={() => setTab("roles")}><Icon name="shield" size={18} /><span>{t("guild.roles")}</span></button>
        )}
      </nav>
      <section className={s.main}>
        <IconButton className={s.close} icon="close" label={t("common.close")} onClick={onClose} />
        {tab === "overview" ? <Overview guild={gs.guild} /> : <Roles guildId={guildId} roles={gs.roles} myPerms={gs.myPerms} />}
      </section>
    </Modal>
  );
}

function Overview({ guild }: { guild: Guild }) {
  const conn = useStore((st) => st.conn);
  const http = useStore((st) => st.http);
  const toast = useStore((st) => st.toast);
  const [name, setName] = useState(guild.name);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const icon = http?.url(guild.icon);

  async function pickIcon(file: File | undefined) {
    if (!file || !http) return;
    try {
      const blob = await squareWebp(file, 256);
      await http.upload(`/api/guilds/${guild.id}/icon`, blob, "icon.webp").promise;
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }

  async function save() {
    if (!conn) return;
    setBusy(true);
    try {
      await conn.call("guild.update", { guildId: guild.id, name: name.trim() });
      toast(t("settings.saved"));
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className={s.h}>{t("guild.overview")}</h2>
      <div className={s.row}>
        <button className={s.guildIcon} onClick={() => fileRef.current?.click()} aria-label={t("guild.icon")} title={t("guild.icon")}>
          {icon ? <img src={icon} alt="" /> : initials(guild.name)}
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => void pickIcon(e.target.files?.[0])} />
        <div style={{ flex: 1, display: "flex", gap: 8, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}><Field label={t("guild.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></div>
          <Button variant="primary" loading={busy} disabled={!name.trim() || name.trim() === guild.name} onClick={() => void save()}>{t("common.save")}</Button>
        </div>
      </div>
    </>
  );
}

function Roles({ guildId, roles, myPerms }: { guildId: string; roles: Role[]; myPerms: number }) {
  const conn = useStore((st) => st.conn);
  const toast = useStore((st) => st.toast);
  const confirm = useConfirm();
  const sorted = [...roles].sort((a, b) => b.position - a.position);
  const [sel, setSel] = useState<string | null>(sorted[0]?.id ?? null);
  const role = roles.find((r) => r.id === sel) ?? null;
  const [name, setName] = useState(role?.name ?? "");
  useEffect(() => setName(role?.name ?? ""), [role?.id, role?.name]);

  const call = async <T,>(p: Promise<T>) => {
    try { return await p; } catch (e) { toast((e as Error).message, "error"); return null; }
  };

  async function create() {
    if (!conn) return;
    const r = await call(conn.call("role.create", { guildId, name: t("roles.newRole"), color: ROLE_COLORS[roles.length % ROLE_COLORS.length]! }));
    if (r) setSel(r.id);
  }

  const togglePerm = (bit: number) => role && conn && void call(conn.call("role.update", { roleId: role.id, perms: role.perms ^ bit }));

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingRight: 40 }}>
        <h2 className={s.h} style={{ flex: 1 }}>{t("guild.roles")}</h2>
        <Button size="small" variant="primary" icon="plus" onClick={() => void create()}>{t("roles.create")}</Button>
      </div>
      <div className={s.roles}>
        <div className={s.roleList}>
          {sorted.map((r) => (
            <button key={r.id} className={cx(s.roleItem, sel === r.id && s.roleOn)} onClick={() => setSel(r.id)}>
              <span className={s.swatch} style={{ background: r.color ?? "var(--nx-text-3)" }} />
              {r.name}
            </button>
          ))}
        </div>
        {role && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {role.isDefault ? (
              <div className={s.note}><Icon name="users" size={18} />{t("roles.default")}</div>
            ) : (
              <>
                <Field label={t("roles.name")} value={name} maxLength={32} onChange={(e) => setName(e.target.value)} onBlur={() => conn && name.trim() && name !== role.name && void call(conn.call("role.update", { roleId: role.id, name: name.trim() }))} />
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <span style={{ font: "700 11px var(--nx-font)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--nx-text-2)" }}>{t("roles.color")}</span>
                  <div className={s.colors} role="radiogroup">
                    {ROLE_COLORS.map((c) => (
                      <button key={c} role="radio" aria-checked={role.color?.toUpperCase() === c} className={s.color} style={{ background: c }} aria-label={c} onClick={() => conn && void call(conn.call("role.update", { roleId: role.id, color: c }))} />
                    ))}
                  </div>
                </div>
              </>
            )}
            <div className={s.perms}>
              {PERM_ORDER.map((p) => {
                const bit = P[p];
                const on = (role.perms & bit) === bit;
                const canGrant = has(myPerms, P.ADMINISTRATOR) || (myPerms & bit) === bit;
                return (
                  <div key={p} className={s.perm}>
                    <span>{t(`perm.${p}` as I18nKey)}</span>
                    <button className={s.toggle} role="switch" aria-checked={on} aria-label={t(`perm.${p}` as I18nKey)} disabled={!canGrant} onClick={() => togglePerm(bit)} />
                  </div>
                );
              })}
            </div>
            {!role.isDefault && (
              <Button
                variant="danger"
                icon="trash"
                style={{ alignSelf: "flex-start" }}
                onClick={async () => {
                  if (conn && (await confirm({ title: t("roles.delete"), body: role.name, confirm: t("common.delete"), danger: true }))) {
                    await call(conn.call("role.delete", { roleId: role.id }));
                    setSel(sorted[0]?.id ?? null);
                  }
                }}
              >
                {t("roles.delete")}
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
