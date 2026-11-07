import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@nooxcord/icons";
import { LIMITS, type Attachment, type Embed, type Message, type PublicUser } from "@nooxcord/shared";
import { t } from "../../i18n";
import { fit } from "../../lib/image";
import { formatBytes, formatFull, formatStamp, formatTime } from "../../lib/format";
import { renderMarkdown } from "../../lib/markdown";
import { platform } from "../../platform";
import { useStore, type PendingMessage } from "../../state/store";
import { Avatar, IconButton, cx } from "../../ui";
import s from "./chat.module.css";

export interface MessageItemProps {
  msg: Message | PendingMessage;
  first: boolean; // starts a new author group
  author: PublicUser | undefined;
  authorColor: string | null;
  replyTo: { author: string; text: string } | null;
  canDelete: boolean;
  mentioned: boolean;
  editing: boolean;
  onReply(m: Message): void;
  onEdit(m: Message | null): void;
  onDelete(m: Message): void;
  onUserClick(e: React.MouseEvent, userId: string): void;
}

export const MessageItem = memo(function MessageItem(p: MessageItemProps) {
  const { msg } = p;
  const me = useStore((st) => st.me);
  const pending = "pending" in msg;
  const own = msg.authorId === me?.id;
  const name = p.author?.nickname ?? "?";

  return (
    <div
      className={cx(s.msg, p.first && s.first, p.mentioned && s.mention, pending && s.pending, pending && (msg as PendingMessage).failed && s.failed, p.editing && s.editing)}
      data-id={msg.id}
    >
      {p.replyTo && (
        <div className={s.reply}>
          <Icon name="reply" size={12} />
          <span className={s.replyName}>{p.replyTo.author}</span>
          <span className={s.replyText}>{p.replyTo.text || t("chat.deletedMessage")}</span>
        </div>
      )}
      <div className={s.gutter}>
        {p.first ? (
          <button style={{ border: 0, background: "none", padding: 0, cursor: "pointer", height: 40 }} onClick={(e) => p.onUserClick(e, msg.authorId)} onContextMenu={(e) => p.onUserClick(e, msg.authorId)} aria-label={name}>
            <Avatar user={p.author ?? { id: msg.authorId, nickname: name, avatar: null }} size={40} />
          </button>
        ) : (
          <time className={s.hoverTime} dateTime={new Date(msg.createdAt).toISOString()} title={formatFull(msg.createdAt)}>{formatTime(msg.createdAt)}</time>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        {p.first && (
          <div className={s.meta}>
            <button className={s.author} style={{ color: p.authorColor ?? undefined }} onClick={(e) => p.onUserClick(e, msg.authorId)} onContextMenu={(e) => p.onUserClick(e, msg.authorId)}>{name}</button>
            <time className={s.time} dateTime={new Date(msg.createdAt).toISOString()} title={formatFull(msg.createdAt)}>{formatStamp(msg.createdAt)}</time>
          </div>
        )}
        {p.editing ? (
          <EditBox msg={msg} onDone={() => p.onEdit(null)} />
        ) : (
          msg.content && (
            <div className={s.text}>
              {renderMarkdown(msg.content)}
              {msg.editedAt && <span className={s.edited} title={formatFull(msg.editedAt)}>{t("chat.edited")}</span>}
              {pending && (msg as PendingMessage).failed && <span className={s.edited}>· {t("chat.failed")}</span>}
            </div>
          )
        )}
        {msg.attachments.length > 0 && (
          <div className={s.atts}>
            {msg.attachments.map((a) => <AttachmentView key={a.id} a={a} />)}
          </div>
        )}
        {msg.embeds.map((e, i) => <EmbedView key={i} e={e} />)}
      </div>
      {!pending && !p.editing && (
        <div className={s.tools}>
          <IconButton icon="reply" size={18} label={t("chat.reply")} onClick={() => p.onReply(msg)} />
          {own && <IconButton icon="edit" size={18} label={t("chat.edit")} onClick={() => p.onEdit(msg)} />}
          {p.canDelete && <IconButton icon="trash" size={18} label={t("chat.delete")} onClick={() => p.onDelete(msg)} />}
        </div>
      )}
    </div>
  );
});

function EditBox({ msg, onDone }: { msg: Message; onDone(): void }) {
  const conn = useStore((st) => st.conn);
  const toast = useStore((st) => st.toast);
  const [text, setText] = useState(msg.content);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; }
  }, [text]);
  async function save() {
    const v = text.trim();
    if (!v || v === msg.content) return onDone();
    try {
      await conn?.call("message.edit", { messageId: msg.id, content: v });
      onDone();
    } catch (e) {
      toast((e as Error).message, "error");
    }
  }
  return (
    <div className={s.editBox}>
      <div className={s.box}>
        <div className={s.inputRow}>
          <textarea
            ref={ref}
            className={s.textarea}
            value={text}
            rows={1}
            maxLength={LIMITS.messageMax}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.stopPropagation(); onDone(); }
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void save(); }
            }}
          />
        </div>
      </div>
      <span className={s.editHint}>{t("chat.editing")}</span>
    </div>
  );
}

function AttachmentView({ a }: { a: Attachment }) {
  const http = useStore((st) => st.http);
  const [open, setOpen] = useState(false);
  const url = a.url.startsWith("blob:") ? a.url : http?.url(a.url) ?? a.url;
  if (a.mime.startsWith("image/")) {
    const box = a.width && a.height ? fit(a.width, a.height, 420, 320) : { width: 320, height: 220 };
    return (
      <>
        <button className={s.img} style={{ width: box.width, height: box.height, maxWidth: "100%" }} onClick={() => setOpen(true)} aria-label={a.name}>
          <img src={url} alt={a.name} loading="lazy" decoding="async" />
        </button>
        {open && createPortal(
          <div className={s.lightbox} onClick={() => setOpen(false)} role="dialog" aria-label={a.name}>
            <img src={url} alt={a.name} />
            <div className={s.lightboxBar}>
              <IconButton icon="external" label={a.name} onClick={(e) => { e.stopPropagation(); platform.openExternal(url); }} />
              <IconButton icon="close" label={t("common.close")} onClick={() => setOpen(false)} />
            </div>
          </div>,
          document.body,
        )}
      </>
    );
  }
  if (a.mime.startsWith("video/")) return <video className={s.video} src={url} controls preload="metadata" />;
  if (a.mime.startsWith("audio/")) return <audio src={url} controls preload="none" style={{ maxWidth: 420 }} />;
  return (
    <div className={s.file}>
      <Icon name="file" size={28} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className={s.fileName}>{a.name}</div>
        <div className={s.fileSize}>{formatBytes(a.size)}</div>
      </div>
      <IconButton icon="download" label={a.name} onClick={() => platform.openExternal(url)} />
    </div>
  );
}

function EmbedView({ e }: { e: Embed }) {
  const open = (ev: React.MouseEvent) => {
    ev.preventDefault();
    platform.openExternal(e.url);
  };
  return (
    <div className={s.embed}>
      {e.site && <div className={s.embedSite}>{e.site}</div>}
      {e.title && <a className={s.embedTitle} href={e.url} onClick={open}>{e.title}</a>}
      {e.description && <div className={s.embedDesc}>{e.description}</div>}
      {e.image && <img className={s.embedImg} src={e.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </div>
  );
}
