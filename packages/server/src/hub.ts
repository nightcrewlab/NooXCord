import type { WebSocket } from "ws";
import type { EventName, Events, ServerFrame } from "@nooxcord/shared";

export interface Conn {
  ws: WebSocket;
  userId: string;
  lastSeen: number;
}

/** Tracks authenticated sockets and fans out events. */
export class Hub {
  private byUser = new Map<string, Set<Conn>>();

  isOnline = (userId: string): boolean => (this.byUser.get(userId)?.size ?? 0) > 0;

  /** Returns true when this is the user's first connection (came online). */
  add(c: Conn): boolean {
    let set = this.byUser.get(c.userId);
    const first = !set || set.size === 0;
    if (!set) this.byUser.set(c.userId, (set = new Set()));
    set.add(c);
    return first;
  }

  /** Returns true when this was the user's last connection (went offline). */
  remove(c: Conn): boolean {
    const set = this.byUser.get(c.userId);
    if (!set?.delete(c)) return false;
    if (set.size === 0) {
      this.byUser.delete(c.userId);
      return true;
    }
    return false;
  }

  send(c: Conn, frame: ServerFrame): void {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(frame));
  }

  toUser<E extends EventName>(userId: string, e: E, d: Events[E]): void {
    const set = this.byUser.get(userId);
    if (!set) return;
    const msg = JSON.stringify({ t: "evt", e, d });
    for (const c of set) if (c.ws.readyState === 1) c.ws.send(msg);
  }

  toUsers<E extends EventName>(userIds: Iterable<string>, e: E, d: Events[E], except?: string): void {
    const msg = JSON.stringify({ t: "evt", e, d });
    for (const id of userIds) {
      if (id === except) continue;
      const set = this.byUser.get(id);
      if (set) for (const c of set) if (c.ws.readyState === 1) c.ws.send(msg);
    }
  }

  /** Disconnects every socket of a user (e.g. after logout). */
  kickUser(userId: string, code: number, reason: string): void {
    for (const c of this.byUser.get(userId) ?? []) c.ws.close(code, reason);
  }

  all(): Conn[] {
    return [...this.byUser.values()].flatMap((s) => [...s]);
  }
}
