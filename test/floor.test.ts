import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import piTalk from "../src/index.ts";
import { FLOOR_FILE_NAME, TalkFloor } from "../src/floor.ts";
import { OpenAISpeechPlayback } from "../src/speech.ts";

function tempStateDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-talk-floor-"));
}

function floorIn(stateDir: string, overrides: ConstructorParameters<typeof TalkFloor>[0] = {}): TalkFloor {
  // Fake pids are never alive, so liveness is stubbed unless a test overrides it.
  return new TalkFloor({ stateDir, pollMs: 2, heartbeatMs: 5, leaseMs: 60, isAlive: () => true, ...overrides });
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() - started >= timeoutMs) reject(new Error("condition timed out"));
      else setTimeout(check, 5);
    };
    check();
  });
}

test("a second instance waits for the floor until the first releases it", async () => {
  const stateDir = tempStateDir();
  try {
    const first = floorIn(stateDir, { pid: 101 });
    const second = floorIn(stateDir, { pid: 102 });
    let waitedBehind: number | undefined;

    assert.equal(await first.acquire(), true);
    assert.equal(first.held, true);

    let granted: boolean | undefined;
    const pending = second.acquire({ onWait: (owner) => (waitedBehind = owner?.pid) }).then((result) => {
      granted = result;
      return result;
    });
    await settle();
    assert.equal(granted, undefined, "the floor is taken, so the second instance must still be waiting");
    assert.equal(waitedBehind, 101);

    first.release();
    assert.equal(await pending, true);
    assert.equal(second.held, true);
    assert.equal(JSON.parse(readFileSync(join(stateDir, FLOOR_FILE_NAME), "utf8")).pid, 102);
    second.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("acquire gives up when shouldAbort turns true", async () => {
  const stateDir = tempStateDir();
  try {
    const holder = floorIn(stateDir, { pid: 201 });
    const waiter = floorIn(stateDir, { pid: 202 });
    await holder.acquire();

    let abort = false;
    const pending = waiter.acquire({ shouldAbort: () => abort });
    await settle();
    abort = true;
    assert.equal(await pending, false);
    assert.equal(waiter.held, false);
    assert.equal(holder.held, true);
    holder.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a lease whose holder is dead is taken over immediately", async () => {
  const stateDir = tempStateDir();
  try {
    writeFileSync(
      join(stateDir, FLOOR_FILE_NAME),
      `${JSON.stringify({ pid: 999_999, token: "gone", startedAt: Date.now() })}\n`,
    );
    const floor = floorIn(stateDir, { pid: 301, isAlive: () => false });
    assert.equal(await floor.acquire(), true);
    assert.equal(JSON.parse(readFileSync(join(stateDir, FLOOR_FILE_NAME), "utf8")).pid, 301);
    floor.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a lease that stopped heartbeating expires even when its pid is alive", async () => {
  const stateDir = tempStateDir();
  try {
    const path = join(stateDir, FLOOR_FILE_NAME);
    writeFileSync(path, `${JSON.stringify({ pid: process.pid, token: "stuck", startedAt: 0 })}\n`);
    const stale = (Date.now() - 10_000) / 1_000;
    utimesSync(path, stale, stale);

    const floor = floorIn(stateDir, { pid: 401, isAlive: () => true });
    assert.equal(await floor.acquire(), true);
    floor.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("the holder refreshes its lease while it keeps the floor", async () => {
  const stateDir = tempStateDir();
  try {
    const path = join(stateDir, FLOOR_FILE_NAME);
    const floor = floorIn(stateDir, { pid: 501 });
    await floor.acquire();
    const past = (Date.now() - 30_000) / 1_000;
    utimesSync(path, past, past);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(Date.now() - statSync(path).mtimeMs < 1_000, "heartbeat should have refreshed the lease");

    floor.release();
    assert.throws(() => statSync(path));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("release never removes a lease another instance has since taken", async () => {
  const stateDir = tempStateDir();
  try {
    const path = join(stateDir, FLOOR_FILE_NAME);
    const first = floorIn(stateDir, { pid: 601 });
    const second = floorIn(stateDir, { pid: 602 });
    await first.acquire();
    rmSync(path);
    await second.acquire();

    first.release();
    assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 602);
    second.release();
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("two Pi instances take turns instead of talking over each other", async (t) => {
  type Handler = (...args: any[]) => any;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousStateDir = process.env.CC_TALK_STATE_DIR;
  const stateDir = tempStateDir();
  process.env.OPENAI_API_KEY = "test-key";
  process.env.CC_TALK_STATE_DIR = stateDir;

  const spoken: string[] = [];
  let playing = 0;
  let overlap = 0;
  const releases: Array<() => void> = [];
  t.mock.method(OpenAISpeechPlayback.prototype, "playChunk", async (text: string) => {
    playing += 1;
    if (playing > 1) overlap += 1;
    spoken.push(text);
    await new Promise<void>((resolve) => releases.push(resolve));
    playing -= 1;
  });
  t.mock.method(OpenAISpeechPlayback.prototype, "resume", async () => undefined);
  t.mock.method(OpenAISpeechPlayback.prototype, "cancel", async () => undefined);

  function instance(label: string) {
    const events = new Map<string, Handler[]>();
    const commands = new Map<string, { handler: Handler }>();
    const notifications: string[] = [];
    const context = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
        setStatus() {},
        async custom() {
          throw new Error("custom UI is not expected here");
        },
      },
    };
    piTalk({
      on(name: string, handler: Handler) {
        events.set(name, [...(events.get(name) ?? []), handler]);
      },
      registerCommand(name: string, options: { handler: Handler }) {
        commands.set(name, options);
      },
      registerShortcut() {},
    } as any);
    const emit = async (name: string, event: unknown) => {
      for (const handler of events.get(name) ?? []) await handler(event, context);
    };
    const respond = async (text: string) => {
      await emit("message_start", { message: { role: "assistant" } });
      await emit("message_update", { assistantMessageEvent: { type: "text_delta", delta: text } });
      await emit("message_end", { message: { role: "assistant", stopReason: "end_turn" } });
    };
    return { label, context, commands, emit, respond, notifications };
  }

  try {
    const a = instance("a");
    const b = instance("b");
    await a.emit("session_start", {});
    await b.emit("session_start", {});
    await a.commands.get("talk")?.handler("", a.context);
    await b.commands.get("talk")?.handler("", b.context);

    await a.respond("First pane speaks.");
    await settle();
    assert.deepEqual(spoken, ["First pane speaks."]);

    await b.respond("Second pane speaks.");
    await settle();
    assert.deepEqual(spoken, ["First pane speaks."], "b must wait while a holds the floor");
    assert.ok(b.notifications.includes("Waiting for another Pi Talk to finish"));

    releases.shift()?.();
    await waitFor(() => spoken.length === 2);
    assert.deepEqual(spoken, ["First pane speaks.", "Second pane speaks."]);
    assert.equal(overlap, 0);

    releases.shift()?.();
    await waitFor(() => releases.length === 0 && playing === 0);
    await a.emit("session_shutdown", {});
    await b.emit("session_shutdown", {});
    assert.throws(() => statSync(join(stateDir, FLOOR_FILE_NAME)), "the floor is free once both are done");
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousStateDir === undefined) delete process.env.CC_TALK_STATE_DIR;
    else process.env.CC_TALK_STATE_DIR = previousStateDir;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
