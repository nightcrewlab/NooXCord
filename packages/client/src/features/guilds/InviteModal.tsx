import { useEffect, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Button, Modal, Spinner } from "../../ui";

export function InviteModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const conn = useStore((st) => st.conn);
  const name = useStore((st) => st.guilds[guildId]?.guild.name ?? "");
  const hostUrl = useStore((st) => st.hostUrl);
  const toast = useStore((st) => st.toast);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    conn?.call("invite.create", { guildId, expiresInHours: 24 * 7 }).then((i) => setCode(i.code), (e: Error) => setError(e.message));
  }, [conn, guildId]);

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast(t("common.copied"));
  };

  return (
    <Modal title={t("guild.inviteTitle", { guild: name })} description={t("guild.inviteDesc")} onClose={onClose}>
      {error ? (
        <div role="alert" style={{ color: "#ff7088" }}>{error}</div>
      ) : !code ? (
        <Spinner />
      ) : (
        <>
          <div style={{ display: "flex", gap: 8 }}>
            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 10, padding: "0 14px", height: 48, borderRadius: 10, background: "var(--nx-bg-0)", border: "1px solid var(--nx-line)", font: "700 20px var(--nx-mono)", letterSpacing: ".08em" }}>
              <Icon name="user-plus" size={20} />
              {code}
            </div>
            <Button variant="primary" icon="copy" onClick={() => copy(code)} style={{ height: 48 }}>{t("common.copy")}</Button>
          </div>
          {hostUrl && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "var(--nx-text-3)", textTransform: "uppercase", letterSpacing: ".04em" }}>{t("guild.inviteLinks")}</div>
              {(() => {
                const url = `${hostUrl}/?invite=${code}`;
                return (
                  <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 12px", borderRadius: 10, background: "var(--nx-bg-0)", border: "1px solid var(--nx-line)" }}>
                    <Icon name="link" size={18} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: "var(--nx-text-2)" }}>{t("guild.inviteLinkCurrent")}</div>
                      <div style={{ fontSize: 13, fontFamily: "var(--nx-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={url}>{url}</div>
                    </div>
                    <Button icon="copy" onClick={() => copy(url)} aria-label={t("common.copy")}>{t("common.copy")}</Button>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
