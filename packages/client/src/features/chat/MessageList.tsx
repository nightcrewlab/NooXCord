import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Icon } from "@nooxcord/icons";
import { P, has, type Channel, type GuildState, type Message } from "@nooxcord/shared";
import { t } from "../../i18n";
import { formatDay, sameDay } from "../../lib/format";
import { useStore, type PendingMessage } from "../../state/store";
import { Button, Spinner, useConfirm } from "../../ui";
import { useUserMenu } from "../members/useUserMenu";
import s from "./chat.module.css";
import { MessageItem } from "./MessageItem";

type Row =
  | { kind: "welcome"; key: string }
  | { kind: "loader"; key: string }
  | { kind: "day"; key: string; ts: number }
  | { kind: "msg"; key: string; msg: Message | PendingMessage; first: boolean };

const GROUP_MS = 7 * 60_000;
const EMPTY: Message[] = [];
const EMPTY_PENDING: PendingMessage[] = [];

/** Highest-positioned coloured role of a member. */
export function roleColor(gs: GuildState, userId: string): string | null {
  const m = gs.members.find((x) => x.userId === userId);
  if (!m) return null;
  let best: { pos: number; color: string } | null = null;
  for (const rid of m.roleIds) {
    const r = gs.roles.find((x) => x.id === rid);
    if (r?.color && (!best || r.position > best.pos)) best = { pos: r.position, color: r.color };
  }
  return best?.color ?? null;
}

export function MessageList({ channel, gs, onReply, editing, setEditing }: { channel: Channel; gs: GuildState; onReply(m: Message): void; editing: string | null; setEditing(id: string | null): void }) {
  const cm = useStore((st) => st.messages[channel.id]);
  const pending = useStore((st) => st.pending[channel.id] ?? EMPTY_PENDING);
  const users = useStore((st) => st.users);
  const me = useStore((st) => st.me);
  const conn = useStore((st) => st.conn);
  const loadMessages = useStore((st) => st.loadMessages);
  const markRead = useStore((st) => st.markRead);
  const toast = useStore((st) => st.toast);
  const confirm = useConfirm();
  const userMenu = useUserMenu(gs);
  const items = cm?.items ?? EMPTY;
  const hasMore = cm?.hasMore ?? true;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    if (cm?.loaded && !hasMore) out.push({ kind: "welcome", key: "welcome" });
    else if (cm?.loaded || cm?.loading) out.push({ kind: "loader", key: "loader" });
    const all: (Message | PendingMessage)[] = pending.length ? [...items, ...pending] : items;
    let prev: Message | null = null;
    for (const m of all) {
      if (!prev || !sameDay(prev.createdAt, m.createdAt)) out.push({ kind: "day", key: `day-${m.id}`, ts: m.createdAt });
      const first = !prev || prev.authorId !== m.authorId || m.createdAt - prev.createdAt > GROUP_MS || !sameDay(prev.createdAt, m.createdAt) || !!m.replyTo;
      out.push({ kind: "msg", key: m.nonce && "pending" in m ? `p-${m.nonce}` : m.id, msg: m, first });
      prev = m;
    }
    return out;
  }, [items, pending, hasMore, cm?.loaded, cm?.loading]);

  const byId = useMemo(() => new Map(items.map((m) => [m.id, m])), [items]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i]?.kind === "day" ? 34 : rows[i]?.kind === "welcome" ? 150 : rows[i]?.kind === "msg" && (rows[i] as { first: boolean }).first ? 64 : 26),
    getItemKey: (i) => rows[i]!.key,
    overscan: 10,
  });

  // initial load per channel
  useEffect(() => {
    atBottom.current = true;
    void loadMessages(channel.id);
  }, [channel.id, loadMessages]);

  // keep pinned to bottom when new rows arrive; preserve position when older rows are prepended
  const prevFirstKey = useRef<string | null>(null);
  const prevTotal = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const firstKey = rows.find((r) => r.kind === "msg")?.key ?? null;
    const total = virt.getTotalSize();
    if (atBottom.current) {
      if (rows.length) virt.scrollToIndex(rows.length - 1, { align: "end" });
    } else if (prevFirstKey.current && firstKey !== prevFirstKey.current) {
      el.scrollTop += total - prevTotal.current; // older page prepended
    }
    prevFirstKey.current = firstKey;
    prevTotal.current = total;
  }, [rows, virt]);

  useEffect(() => {
    if (atBottom.current && document.hasFocus()) markRead(channel.id);
  }, [rows.length, channel.id, markRead]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    atBottom.current = bottom;
    setShowJump(!bottom && el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
    if (bottom) markRead(channel.id);
    if (el.scrollTop < 400 && hasMore && cm?.loaded && !cm.loading) void loadMessages(channel.id, true);
  }, [channel.id, hasMore, cm?.loaded, cm?.loading, loadMessages, markRead]);

  const canManage = has(gs.myPerms, P.MANAGE_MESSAGES);
  const mentionRe = useMemo(() => (me ? new RegExp(`@${me.nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null), [me]);

  const onDelete = useCallback(async (m: Message) => {
    if (!(await confirm({ title: t("chat.delete"), body: t("chat.deleteConfirm"), confirm: t("common.delete"), danger: true }))) return;
    conn?.call("message.delete", { messageId: m.id }).catch((e: Error) => toast(e.message, "error"));
  }, [conn, confirm, toast]);

  const onEdit = useCallback((m: Message | null) => setEditing(m?.id ?? null), [setEditing]);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={scrollRef} className={s.scroller} onScroll={onScroll} role="log" aria-live="polite">
        <div className={s.inner} style={{ height: virt.getTotalSize() }}>
          {virt.getVirtualItems().map((vi) => {
            const row = rows[vi.index]!;
            return (
              <div key={vi.key} ref={virt.measureElement} data-index={vi.index} className={s.row} style={{ transform: `translateY(${vi.start}px)` }}>
                {row.kind === "welcome" && (
                  <div className={s.welcome}>
                    <div className={s.welcomeIcon}><Icon name="hash" size={36} /></div>
                    <h3 className={s.welcomeTitle}>{t("chat.welcome", { channel: channel.name })}</h3>
                    <p className={s.welcomeDesc}>{t("chat.welcomeDesc")}</p>
                  </div>
                )}
                {row.kind === "loader" && <div className={s.loader}><Spinner />{t("chat.loadingOlder")}</div>}
                {row.kind === "day" && <div className={s.day}>{formatDay(row.ts)}</div>}
                {row.kind === "msg" && (
                  <MessageItem
                    msg={row.msg}
                    first={row.first}
                    author={users[row.msg.authorId]}
                    authorColor={roleColor(gs, row.msg.authorId)}
                    replyTo={row.msg.replyTo ? replyPreview(byId.get(row.msg.replyTo), users) : null}
                    canDelete={row.msg.authorId === me?.id || canManage}
                    mentioned={!!mentionRe && row.msg.authorId !== me?.id && mentionRe.test(row.msg.content)}
                    editing={editing === row.msg.id}
                    onReply={onReply}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onUserClick={userMenu}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {showJump && (
        <Button className={s.jump} size="small" variant="primary" icon="chevron-down" onClick={() => { atBottom.current = true; virt.scrollToIndex(rows.length - 1, { align: "end" }); }}>
          {t("chat.jumpLatest")}
        </Button>
      )}
    </div>
  );
}

function replyPreview(m: Message | undefined, users: Record<string, { nickname: string }>) {
  if (!m) return { author: "", text: "" };
  return { author: users[m.authorId]?.nickname ?? "?", text: m.content.slice(0, 120) || (m.attachments[0]?.name ?? "") };
}
