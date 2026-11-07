import { useState, type FormEvent } from "react";
import { Icon } from "@nooxcord/icons";
import { LIMITS, type Channel, type ChannelKind } from "@nooxcord/shared";
import { t } from "../../i18n";
import { useStore } from "../../state/store";
import { Button, Field, Modal, cx } from "../../ui";
import s from "./channels.module.css";

/** Create a channel (kind picker) or edit an existing one (name + topic). */
export function ChannelModal({ guildId, kind: initialKind, channel, onClose }: { guildId: string; kind?: ChannelKind; channel?: Channel; onClose: () => void }) {
  const conn = useStore((st) => st.conn);
  const selectChannel = useStore((st) => st.selectChannel);
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? initialKind ?? "text");
  const [name, setName] = useState(channel?.name ?? "");
  const [topic, setTopic] = useState(channel?.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!conn || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (channel) await conn.call("channel.update", { channelId: channel.id, name, topic });
      else {
        const ch = await conn.call("channel.create", { guildId, name, kind });
        if (ch.kind === "text") selectChannel(guildId, ch.id);
      }
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={channel ? t("channel.edit") : t("channel.create")}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>{channel ? t("common.save") : t("common.create")}</Button>
        </>
      }
    >
      <form onSubmit={submit} style={{ display: "contents" }}>
        {!channel && (
          <div className={s.kinds} role="radiogroup" aria-label={t("channel.kind")}>
            {(["text", "voice"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={cx(s.kind, kind === k && s.kindOn)} onClick={() => setKind(k)}>
                <Icon name={k === "text" ? "hash" : "speaker"} size={22} />
                <span>
                  <b>{k === "text" ? t("channel.kindText") : t("channel.kindVoice")}</b>
                  <small>{k === "text" ? t("channel.kindTextDesc") : t("channel.kindVoiceDesc")}</small>
                </span>
              </button>
            ))}
          </div>
        )}
        <Field label={t("channel.name")} value={name} onChange={(e) => setName(e.target.value)} maxLength={LIMITS.channelNameMax} placeholder="yeni-kanal" />
        {channel?.kind === "text" && <Field label={t("channel.topic")} value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={LIMITS.topicMax} />}
        {error && <div role="alert" style={{ color: "#ff7088", fontSize: 14 }}>{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
