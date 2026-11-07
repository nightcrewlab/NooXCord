import { randomBytes } from "node:crypto";
import type { ErrorCode } from "@nooxcord/shared";

let lastTs = 0;
let seq = 0;

/** Time-sortable id: 10 chars base36 millis + 2 chars sequence + 8 chars random. */
export function newId(): string {
  const now = Date.now();
  if (now === lastTs) seq++;
  else {
    lastTs = now;
    seq = 0;
  }
  return (
    now.toString(36).padStart(10, "0") +
    (seq % 1296).toString(36).padStart(2, "0") +
    randomBytes(5).toString("hex").slice(0, 8)
  );
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

const INVITE_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function inviteCode(len = 8): string {
  const b = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += INVITE_ALPHABET[b[i]! % INVITE_ALPHABET.length];
  return s;
}

export class AppError extends Error {
  constructor(readonly code: ErrorCode, msg: string) {
    super(msg);
  }
}

export const fail = (code: ErrorCode, msg: string): never => {
  throw new AppError(code, msg);
};

export const httpStatus: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  internal: 500,
};
