import { create } from "zustand";
import type { EventName, Events, RemoteInputEvent, VoiceState } from "@nooxcord/shared";
import { t } from "../i18n";
import type { HostConnection } from "../net/connection";
import { platform } from "../platform";
import { useStore } from "../state/store";

/*
 * Remote control (CLAUDE.md §7), both sides.
 *  Viewer: "Kontrol iste" -> remote.request; once the streamer's state names us as controller we
 *          capture pointer/keyboard on their stream tile and send {t:"rc"} batches (one per frame).
 *  Streamer: incoming requests (accept / deny / always this session), right-click "give control",
 *          input from the host goes to the main process (SendInput). The panic shortcut, the visible
 *          frame and the local-input priority live in the main process (apps/desktop/src/main/remote.ts).
 * Browsers never take part: the host refuses them and the buttons are not shown.
 */

interface RemoteUi {
  /** Viewers waiting for an answer (streamer side). */
  requests: string[];
  /** Streamer we asked and are waiting on (viewer side). */
  asked: string | null;
  /** Streamer whose screen we control now (viewer side). */
  controlling: string | null;
  /** Viewer controlling our stream now (streamer side). */
  controlledBy: string | null;
}

export const useRemote = create<RemoteUi>()(() => ({ requests: [], asked: null, controlling: null, controlledBy: null }));

/** This client can ask for / grant remote control (desktop app with the native module, not a guest). */
export function remoteCapable(): boolean {
  return platform.kind === "desktop" && !!platform.remote && !useStore.getState().me?.guest;
}

class RemoteControl {
  private conn: HostConnection | null = null;
  private off: (() => void) | null = null;
  private always = new Set<string>();
  private queue: RemoteInputEvent[] = [];
  private lastMove: RemoteInputEvent | null = null;
  private raf = 0;
  private offPanic: (() => void) | null = null;

  bind(conn: HostConnection): void {
    if (this.conn === conn) return;
    this.off?.();
    this.conn = conn;
    this.off = conn.on(<E extends EventName>(e: E, d: Events[E]) => this.onEvent(e, d));
    this.offPanic ??= platform.remote?.onPanic(() => void this.revoke()) ?? null;
  }

  private toast(text: string, kind?: "error") {
    useStore.getState().toast(text, kind);
  }

  private name(id: string): string {
    return useStore.getState().users[id]?.nickname ?? "?";
  }

  private onEvent<E extends EventName>(e: E, raw: Events[E]): void {
    switch (e) {
      case "remote.request": {
        const { userId } = raw as Events["remote.request"];
        if (this.always.has(userId)) return void this.respond(userId, true);
        useRemote.setState((s) => ({ requests: s.requests.includes(userId) ? s.requests : [...s.requests, userId] }));
        return;
      }
      case "remote.answer": {
        const { streamerId, allow } = raw as Events["remote.answer"];
        if (useRemote.getState().asked === streamerId) useRemote.setState({ asked: null });
        if (!allow) this.toast(t("remote.denied", { user: this.name(streamerId) }));
        return;
      }
      case "remote.input": {
        const { from, ev } = raw as Events["remote.input"];
        if (useRemote.getState().controlledBy === from) platform.remote?.input(ev);
        return;
      }
      case "voice.state":
        return this.onState(raw as VoiceState);
      case "voice.leave": {
        const { userId } = raw as Events["voice.leave"];
        const me = useStore.getState().me?.id;
        if (userId === me) return this.reset();
        if (useRemote.getState().controlling === userId) this.setControlling(null);
        useRemote.setState((s) => ({ requests: s.requests.filter((x) => x !== userId), asked: s.asked === userId ? null : s.asked }));
        return;
      }
      case "voice.ended":
        return this.reset();
    }
  }

  private onState(v: VoiceState): void {
    const me = useStore.getState().me?.id;
    if (!me) return;
    const controller = v.stream?.controllerId ?? null;
    if (v.userId === me) {
      if (!v.stream) useRemote.setState({ requests: [] });
      const cur = useRemote.getState().controlledBy;
      if (controller === cur) return;
      useRemote.setState({ controlledBy: controller });
      if (controller) {
        void platform.remote?.begin(t("remote.frame", { user: this.name(controller) })).then((r) => {
          if (!r.ok) {
            this.toast(t("remote.unavailable"), "error");
            void this.revoke();
          }
        });
      } else void platform.remote?.end();
      return;
    }
    const st = useRemote.getState();
    if (controller === me && st.controlling !== v.userId) this.setControlling(v.userId);
    else if (controller !== me && st.controlling === v.userId) this.setControlling(null);
  }

  private setControlling(id: string | null) {
    this.queue = [];
    this.lastMove = null;
    useRemote.setState({ controlling: id, asked: null });
  }

  reset(): void {
    if (useRemote.getState().controlledBy) void platform.remote?.end();
    this.queue = [];
    useRemote.setState({ requests: [], asked: null, controlling: null, controlledBy: null });
  }

  // ---------- viewer ----------
  async request(streamerId: string): Promise<void> {
    if (!this.conn) return;
    useRemote.setState({ asked: streamerId });
    try {
      await this.conn.call("remote.request", { userId: streamerId });
    } catch (e) {
      useRemote.setState({ asked: null });
      this.toast((e as Error).message, "error");
    }
  }

  async release(): Promise<void> {
    const id = useRemote.getState().controlling;
    if (!id || !this.conn) return;
    this.setControlling(null);
    await this.conn.call("remote.stop", { streamerId: id }).catch(() => {});
  }

  /** Queue input for the streamer we control; flushed once per animation frame. */
  send(ev: RemoteInputEvent): void {
    if (!useRemote.getState().controlling) return;
    if (ev.k === "m") this.lastMove = ev;
    else {
      if (this.lastMove) this.queue.push(this.lastMove), (this.lastMove = null); // keep order: move before click
      this.queue.push(ev);
    }
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush());
  }

  private flush(): void {
    this.raf = 0;
    const to = useRemote.getState().controlling;
    if (this.lastMove) this.queue.push(this.lastMove);
    this.lastMove = null;
    const ev = this.queue.splice(0, 64);
    if (to && ev.length) this.conn?.sendFrame({ t: "rc", to, ev });
    if (this.queue.length) this.raf = requestAnimationFrame(() => this.flush());
  }

  // ---------- streamer ----------
  async respond(userId: string, allow: boolean, always = false): Promise<void> {
    useRemote.setState((s) => ({ requests: s.requests.filter((x) => x !== userId) }));
    if (always) this.always.add(userId);
    await this.conn?.call("remote.respond", { userId, allow }).catch((e: Error) => this.toast(e.message, "error"));
  }

  give(userId: string): Promise<void> {
    return this.respond(userId, true);
  }

  async revoke(): Promise<void> {
    const me = useStore.getState().me?.id;
    void platform.remote?.end();
    if (me) await this.conn?.call("remote.stop", { streamerId: me }).catch(() => {});
  }
}

export const remote = new RemoteControl();
