import { useEffect, useRef, useState } from "react";
import { Icon } from "@nooxcord/icons";
import { LIMITS, P, has, type Attachment, type Channel, type GuildState, type Message } from "@nooxcord/shared";
import { t } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { imageSize } from "../../lib/image";
import { DM_HOME, useStore } from "../../state/store";
import { IconButton, cx } from "../../ui";
import s from "./chat.module.css";

interface Upload {
  id: number;
  file: File;
  preview: string | null;
  pct: number;
  result: Attachment | null;
  error: boolean;
  abort: () => void;
}

let upSeq = 0;
const drafts = new Map<string, string>();

export function Composer({ channel, gs, replyTo, clearReply, onEditLast }: { channel: Channel; gs: GuildState; replyTo: Message | null; clearReply(): void; onEditLast(): void }) {
  const http = useStore((st) => st.http);
  const conn = useStore((st) => st.conn);
  const users = useStore((st) => st.users);
  const me = useStore((st) => st.me);
  const typing = useStore((st) => st.typing[channel.id]);
  const sendMessage = useStore((st) => st.sendMessage);
  const toast = useStore((st) => st.toast);
  const [text, setText] = useState(() => drafts.get(channel.id) ?? "");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [drag, setDrag] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const canSend = has(gs.myPerms, P.SEND_MESSAGES);
  const canAttach = has(gs.myPerms, P.ATTACH_FILES);

  useEffect(() => {
    setText(drafts.get(channel.id) ?? "");
    setUploads((u) => { u.forEach((x) => x.abort()); return []; });
    ref.current?.focus();
  }, [channel.id]);
  useEffect(() => { if (replyTo) ref.current?.focus(); }, [replyTo]);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`; }
    drafts.set(channel.id, text);
  }, [text, channel.id]);

  function addFiles(files: FileList | File[]) {
    if (!http || !canAttach) return;
    for (const file of Array.from(files).slice(0, LIMITS.attachmentsPerMessage - uploads.length)) {
      if (file.size > LIMITS.uploadMaxBytes) {
        toast(t("chat.tooLarge", { file: file.name, max: formatBytes(LIMITS.uploadMaxBytes) }), "error");
        continue;
      }
      const id = ++upSeq;
      const preview = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
      void (async () => {
        const dims = file.type.startsWith("image/") ? await imageSize(file) : null;
        const fields: Record<string, string> = dims ? { width: String(dims.width), height: String(dims.height) } : {};
        const up = http.upload(`/api/uploads`, file, file.name, fields, (pct) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, pct } : x))));
        setUploads((u) => [...u, { id, file, preview, pct: 0, result: null, error: false, abort: up.abort }]);
        try {
          const result = await up.promise;
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, result, pct: 100 } : x)));
        } catch (e) {
          if ((e as { code?: string }).code !== "aborted") toast(t("chat.uploadFailed", { file: file.name }), "error");
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, error: true } : x)));
        }
      })();
    }
  }

  function removeUpload(id: number) {
    setUploads((u) => {
      const x = u.find((y) => y.id === id);
      x?.abort();
      if (x?.preview) URL.revokeObjectURL(x.preview);
      return u.filter((y) => y.id !== id);
    });
  }

  const busy = uploads.some((u) => !u.result && !u.error);
  function submit() {
    const content = text.trim();
    const ready = uploads.filter((u) => u.result);
    if (busy || (!content && ready.length === 0)) return;
    void sendMessage(channel.id, content, {
      replyTo: replyTo?.id,
      attachmentIds: ready.map((u) => u.result!.id),
      preview: ready.map((u) => ({ ...u.result!, url: u.preview ?? u.result!.url })),
    });
    setText("");
    setUploads([]);
    clearReply();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && replyTo) {
      clearReply();
    } else if (e.key === "ArrowUp" && !text) {
      e.preventDefault();
      onEditLast();
    }
  }

  function onChange(v: string) {
    setText(v);
    const now = Date.now();
    if (v && conn && now - lastTyping.current > 3000) {
      lastTyping.current = now;
      conn.call("typing", { channelId: channel.id }).catch(() => {});
    }
  }

  const typers = Object.keys(typing ?? {}).filter((id) => id !== me?.id).map((id) => users[id]?.nickname ?? "?");
  const typingText = typers.length === 0 ? "" : typers.length === 1 ? t("chat.typing1", { a: typers[0]! }) : typers.length === 2 ? t("chat.typing2", { a: typers[0]!, b: typers[1]! }) : t("chat.typingN");

  if (!canSend) {
    return (
      <div className={s.composer}>
        <div className={s.typing} />
        <div className={cx(s.box, s.readonly)}><Icon name="lock" size={16} />{t("chat.noPermission")}</div>
      </div>
    );
  }

  return (
    <div
      className={s.composer}
      onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDrag(true); } }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
    >
      <div className={cx(s.box, drag && s.drag)}>
        {replyTo && (
          <div className={s.bar}>
            <Icon name="reply" size={16} />
            <span><b>{users[replyTo.authorId]?.nickname}</b> {t("chat.replyingTo")}</span>
            <IconButton icon="close" size={16} label={t("common.cancel")} onClick={clearReply} />
          </div>
        )}
        {uploads.length > 0 && (
          <div className={s.uploads}>
            {uploads.map((u) => (
              <div key={u.id} className={cx(s.up, u.error && s.upErr)} title={u.file.name}>
                {u.preview ? <img src={u.preview} alt="" /> : <Icon name="file" size={28} />}
                {!u.preview && <span className={s.upName}>{u.file.name}</span>}
                {!u.result && !u.error && <span className={s.upProg} style={{ width: `${u.pct}%` }} />}
                <IconButton className={s.upX} icon="close" size={14} label={t("common.delete")} onClick={() => removeUpload(u.id)} />
              </div>
            ))}
          </div>
        )}
        <div className={s.inputRow}>
          {canAttach && (
            <>
              <IconButton icon="paperclip" label={t("chat.attach")} onClick={() => document.getElementById(`file-${channel.id}`)?.click()} />
              <input id={`file-${channel.id}`} type="file" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
            </>
          )}
          <textarea
            ref={ref}
            className={s.textarea}
            rows={1}
            value={text}
            maxLength={LIMITS.messageMax}
            placeholder={(channel.guildId === DM_HOME ? t("dm.placeholder", { user: channel.name }) : t("chat.placeholder", { channel: channel.name }))}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => { if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); } }}
            aria-label={(channel.guildId === DM_HOME ? t("dm.placeholder", { user: channel.name }) : t("chat.placeholder", { channel: channel.name }))}
          />
          <IconButton icon="send" label={t("chat.send")} onClick={submit} disabled={busy || (!text.trim() && !uploads.some((u) => u.result))} />
        </div>
      </div>
      <div className={s.typing} aria-live="polite">
        {typingText && (<><span className={s.dots}><i /><i /><i /></span>{typingText}</>)}
      </div>
    </div>
  );
}
