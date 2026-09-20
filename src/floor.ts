import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { speakerStateDir } from "./speaker.ts";

/**
 * The floor is the right to be the one Pi Talk speaking. Every Pi instance on
 * the machine shares it through a lease file in the speaker state dir, so a
 * response finishing in one pane queues behind, rather than talking over or
 * cutting off, the message another pane is still reading aloud.
 */
export const FLOOR_FILE_NAME = "talk.lock";
/** How often the holder refreshes its lease while it keeps the floor. */
export const FLOOR_HEARTBEAT_MS = 5_000;
/** A lease not refreshed for this long belongs to a holder that died mid-hold. */
export const FLOOR_LEASE_MS = 15_000;
const DEFAULT_POLL_MS = 250;

export type FloorOwner = {
  pid: number;
  /** Distinguishes instances that share a pid, such as tests in one process. */
  token: string;
  startedAt: number;
};

export type FloorOptions = {
  /** Resolved on every claim so a changed CC_TALK_STATE_DIR is honoured. */
  stateDir?: string | (() => string);
  pid?: number;
  isAlive?(pid: number): boolean;
  pollMs?: number;
  heartbeatMs?: number;
  leaseMs?: number;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
};

export type FloorAcquireOptions = {
  /** Polled between attempts; a true result abandons the wait. */
  shouldAbort?(): boolean;
  /** Called once, the first time the floor turns out to be taken. */
  onWait?(owner: FloorOwner | undefined): void;
};

function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseOwner(contents: string): FloorOwner | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const owner = parsed as Partial<FloorOwner> | null;
  if (!owner || !Number.isInteger(owner.pid) || typeof owner.token !== "string") return undefined;
  return {
    pid: owner.pid as number,
    token: owner.token,
    startedAt: Number.isFinite(owner.startedAt) ? (owner.startedAt as number) : 0,
  };
}

export class TalkFloor {
  private readonly resolveStateDir: () => string;
  private readonly pid: number;
  private readonly token: string;
  private readonly isAlive: (pid: number) => boolean;
  private readonly pollMs: number;
  private readonly heartbeatMs: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private heartbeat?: NodeJS.Timeout;
  private heldPath?: string;

  constructor(options: FloorOptions = {}) {
    const stateDir = options.stateDir;
    this.resolveStateDir =
      typeof stateDir === "function" ? stateDir : () => stateDir ?? speakerStateDir(process.env);
    this.pid = options.pid ?? process.pid;
    this.token = randomBytes(6).toString("hex");
    this.isAlive = options.isAlive ?? defaultIsAlive;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? FLOOR_HEARTBEAT_MS;
    this.leaseMs = options.leaseMs ?? FLOOR_LEASE_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  get held(): boolean {
    return this.heldPath !== undefined;
  }

  /** Who holds the floor right now, or undefined when it is free or stale. */
  peek(): FloorOwner | undefined {
    const path = join(this.resolveStateDir(), FLOOR_FILE_NAME);
    return this.liveOwner(path);
  }

  /**
   * Waits for the floor, polling until it is free, stale, or `shouldAbort`
   * says to stop. Resolves true once held. Holding it already is a no-op.
   */
  async acquire(options: FloorAcquireOptions = {}): Promise<boolean> {
    let waited = false;
    while (true) {
      if (this.held) return true;
      if (options.shouldAbort?.()) return false;
      if (this.tryClaim()) return true;
      if (!waited) {
        waited = true;
        options.onWait?.(this.peek());
      }
      await this.sleep(this.pollMs);
    }
  }

  /** Gives the floor back, but only if this instance still owns the lease. */
  release(): void {
    const path = this.heldPath;
    if (!path) return;
    this.heldPath = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;

    const owner = this.readOwner(path);
    if (owner && owner.token !== this.token) return;
    rmSync(path, { force: true });
  }

  private tryClaim(): boolean {
    const stateDir = this.resolveStateDir();
    const path = join(stateDir, FLOOR_FILE_NAME);
    mkdirSync(stateDir, { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number;
      try {
        fd = openSync(path, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const owner = this.liveOwner(path);
        if (owner?.token === this.token) {
          this.hold(path);
          return true;
        }
        if (owner) return false;
        // Dead or expired lease: clear it and try the exclusive create once more.
        rmSync(path, { force: true });
        continue;
      }
      try {
        const owner: FloorOwner = { pid: this.pid, token: this.token, startedAt: this.now() };
        writeSync(fd, `${JSON.stringify(owner)}\n`);
      } finally {
        closeSync(fd);
      }
      this.hold(path);
      return true;
    }
    return false;
  }

  private hold(path: string): void {
    this.heldPath = path;
    this.heartbeat = setInterval(() => {
      const seconds = this.now() / 1_000;
      try {
        utimesSync(path, seconds, seconds);
      } catch {
        // The lease was removed underneath us; the next claim starts afresh.
      }
    }, this.heartbeatMs);
    this.heartbeat.unref();
  }

  private readOwner(path: string): FloorOwner | undefined {
    try {
      return parseOwner(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  /**
   * A lease counts as live only while its holder is alive and still
   * refreshing it. A file with no owner yet is one being written this instant
   * unless it has sat unclaimed longer than a lease.
   */
  private liveOwner(path: string): FloorOwner | undefined {
    let ageMs: number;
    try {
      ageMs = this.now() - statSync(path).mtimeMs;
    } catch {
      return undefined;
    }
    if (ageMs > this.leaseMs) return undefined;

    const owner = this.readOwner(path);
    if (!owner) return { pid: 0, token: "", startedAt: 0 };
    if (owner.token !== this.token && !this.isAlive(owner.pid)) return undefined;
    return owner;
  }
}
