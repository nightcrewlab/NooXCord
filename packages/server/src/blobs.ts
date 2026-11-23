import type { Db } from "./db";
import { newId } from "./util";

/** Uploaded files, avatars and server icons, stored in the database in 512 KB parts (migration 4, ADR 0003). */
const PART = 512 * 1024;

export class Blobs {
  constructor(private db: Db) {}

  put(data: Uint8Array): string {
    const id = newId();
    this.db.tx(() => {
      this.db.run("INSERT INTO blobs (id, size, created_at) VALUES (?, ?, ?)", id, data.byteLength, Date.now());
      for (let i = 0, idx = 0; i < data.byteLength || idx === 0; i += PART, idx++) {
        this.db.run("INSERT INTO blob_parts (blob_id, idx, data) VALUES (?, ?, ?)", id, idx, data.subarray(i, i + PART));
      }
    });
    return id;
  }

  get(id: string): Buffer | null {
    const parts = this.db.all<{ data: Uint8Array }>("SELECT data FROM blob_parts WHERE blob_id = ? ORDER BY idx", id);
    if (!parts.length) return null;
    return Buffer.concat(parts.map((p) => p.data));
  }

  delete(ids: Iterable<string>): void {
    const list = [...ids].filter(Boolean);
    if (!list.length) return;
    this.db.tx(() => { for (const id of list) this.db.run("DELETE FROM blobs WHERE id = ?", id); });
  }
}

/** Blob id inside "/avatars/<id>.<ext>" style URLs. */
export function blobIdOf(url: string | null | undefined): string | null {
  const m = url ? /\/([a-z0-9]+)\.(png|jpeg|gif|webp)$/.exec(url) : null;
  return m ? m[1]! : null;
}
