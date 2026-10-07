import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AppConfig } from "../config/index.js";

interface Session { csrf: string; expires: number; }
const TTL_MS = 12 * 60 * 60 * 1000;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  if (password.length < 12) throw new Error("Admin password must be at least 12 characters");
  return `scrypt$${salt}$${scryptSync(password, Buffer.from(salt, "hex"), 64).toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [method, salt, expected] = stored.split("$");
  if (method !== "scrypt" || !salt || !expected || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(expected)) {
    return false;
  }
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 64);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export class AuthService {
  private readonly sessions = new Map<string, Session>();
  private readonly failed = new Map<string, { count: number; until: number }>();
  constructor(private readonly config: AppConfig) {}

  get enabled(): boolean { return Boolean(this.config.adminUsername && this.config.adminPasswordHash && this.config.sessionSecret); }

  login(username: string, password: string, remote = "local"): { cookie: string; csrf: string } | null {
    if (!this.enabled) return null;
    const limit = this.failed.get(remote);
    if (limit && limit.count >= 5 && limit.until > Date.now()) return null;
    const valid = username === this.config.adminUsername && verifyPassword(password, this.config.adminPasswordHash!);
    if (!valid) {
      const count = limit && limit.until > Date.now() ? limit.count + 1 : 1;
      this.failed.set(remote, { count, until: Date.now() + 15 * 60_000 });
      return null;
    }
    this.failed.delete(remote);
    const id = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.sessions.set(id, { csrf, expires: Date.now() + TTL_MS });
    const signature = this.sign(id);
    return { cookie: this.cookie(`${id}.${signature}`, Math.floor(TTL_MS / 1000)), csrf };
  }

  session(req: IncomingMessage): { id: string; csrf: string } | null {
    if (!this.enabled) return null;
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("la_session="));
    if (!cookie) return null;
    const raw = cookie.slice("la_session=".length);
    const [id, signature] = raw.split(".");
    if (!id || !signature || !/^[\w-]+$/.test(id)) return null;
    const expected = this.sign(id);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const item = this.sessions.get(id);
    if (!item || item.expires <= Date.now()) { this.sessions.delete(id); return null; }
    return { id, csrf: item.csrf };
  }

  logout(id: string): string {
    this.sessions.delete(id);
    return this.cookie("", 0);
  }

  csrfValid(req: IncomingMessage, csrf: string): boolean {
    const supplied = req.headers["x-csrf-token"];
    if (typeof supplied !== "string") return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(csrf);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private sign(id: string): string {
    return createHmac("sha256", this.config.sessionSecret!).update(id).digest("base64url");
  }

  private cookie(value: string, maxAge: number): string {
    return `la_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.config.cookieSecure ? "; Secure" : ""}`;
  }
}
