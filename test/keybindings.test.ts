import assert from "node:assert/strict";
import test from "node:test";
import piTalk from "../src/index.ts";
import { OPENAI_SPEECH_MODEL } from "../src/speech.ts";
import {
  COARSE_SPEED_STEP,
  DEFAULT_PLAYBACK_SPEED,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  PRIMARY_SHORTCUT,
  SPEED_DOWN_SHORTCUT,
  SPEED_UP_SHORTCUT,
  clampPlaybackSpeed,
  primaryShortcutAction,
  registerPiTalkShortcuts,
} from "../src/controls.ts";

test("registers direct Pi Talk shortcuts and routes their actions", async () => {
  const registrations = new Map<
    string,
    { description?: string; handler: (context: unknown) => Promise<void> | void }
  >();
  const activationCalls: unknown[] = [];
  const speedCalls: Array<{ context: unknown; delta: number }> = [];
  const context = { source: "test" };

  registerPiTalkShortcuts(
    {
      registerShortcut(shortcut, options) {
        registrations.set(shortcut, options);
      },
    },
    {
      activate(received) {
        activationCalls.push(received);
      },
      adjustSpeed(received, delta) {
        speedCalls.push({ context: received, delta });
      },
    },
  );

  assert.deepEqual([...registrations.keys()], [PRIMARY_SHORTCUT, SPEED_UP_SHORTCUT, SPEED_DOWN_SHORTCUT]);
  assert.equal(registrations.get(PRIMARY_SHORTCUT)?.description, "Talk, pause, or unpause Pi Talk");
  assert.equal(registrations.get(SPEED_UP_SHORTCUT)?.description, "Increase Pi Talk playback speed");
  assert.equal(registrations.get(SPEED_DOWN_SHORTCUT)?.description, "Decrease Pi Talk playback speed");

  await registrations.get(PRIMARY_SHORTCUT)?.handler(context);
  await registrations.get(SPEED_UP_SHORTCUT)?.handler(context);
  await registrations.get(SPEED_DOWN_SHORTCUT)?.handler(context);
  assert.deepEqual(activationCalls, [context]);
  assert.deepEqual(speedCalls, [
    { context, delta: COARSE_SPEED_STEP },
    { context, delta: -COARSE_SPEED_STEP },
  ]);
});

test("primary shortcut follows the gagged talking paused cycle", () => {
  assert.equal(primaryShortcutAction("gagged"), "talk");
  assert.equal(primaryShortcutAction("talking"), "pause");
  assert.equal(primaryShortcutAction("paused"), "unpause");
});

test("speed calculations retain the existing playback bounds", () => {
  assert.equal(clampPlaybackSpeed(DEFAULT_PLAYBACK_SPEED - COARSE_SPEED_STEP), 1.15);
  assert.equal(clampPlaybackSpeed(DEFAULT_PLAYBACK_SPEED + COARSE_SPEED_STEP), 1.35);
  assert.equal(clampPlaybackSpeed(MIN_PLAYBACK_SPEED - COARSE_SPEED_STEP), MIN_PLAYBACK_SPEED);
  assert.equal(clampPlaybackSpeed(MAX_PLAYBACK_SPEED + COARSE_SPEED_STEP), MAX_PLAYBACK_SPEED);
});

test("direct shortcut and slash commands share the live speech state", async () => {
  type Handler = (...args: any[]) => any;

  const previousKey = process.env.OPENAI_API_KEY;
  const previousSpeed = process.env.PI_TALK_SPEED;
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.PI_TALK_SPEED;

  try {
    const events = new Map<string, Handler[]>();
    const commands = new Map<string, { handler: Handler }>();
    const shortcuts = new Map<string, { handler: Handler }>();
    const notifications: Array<{ message: string; level: string }> = [];
    const statuses: string[] = [];
    const context = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify(message: string, level = "info") {
          notifications.push({ message, level });
        },
        setStatus(_id: string, value: string | undefined) {
          statuses.push(value ?? "");
        },
        async custom() {
          throw new Error("custom UI is not expected in shortcut state tests");
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
      registerShortcut(shortcut: string, options: { handler: Handler }) {
        shortcuts.set(shortcut, options);
      },
    } as any);

    for (const handler of events.get("session_start") ?? []) await handler({}, context);

    const invokeShortcut = async (shortcut = PRIMARY_SHORTCUT) => {
      const registration = shortcuts.get(shortcut);
      assert.ok(registration, `${shortcut} should be registered by src/index.ts`);
      await registration.handler(context);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    const lastStatus = () => statuses[statuses.length - 1];
    const lastNotification = () => notifications[notifications.length - 1];

    await commands.get("speed")?.handler("1.50", context);
    await invokeShortcut(SPEED_UP_SHORTCUT);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ■ · 1.60×`);
    assert.equal(lastNotification().message, "Playback speed set to 1.60× for the next utterance");
    await invokeShortcut(SPEED_DOWN_SHORTCUT);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ■ · 1.50×`);
    assert.equal(lastNotification().message, "Playback speed set to 1.50× for the next utterance");

    await commands.get("speed")?.handler("3.00", context);
    await invokeShortcut(SPEED_UP_SHORTCUT);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ■ · 3.00×`);
    await commands.get("speed")?.handler("0.50", context);
    await invokeShortcut(SPEED_DOWN_SHORTCUT);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ■ · 0.50×`);
    await commands.get("speed")?.handler("1.25", context);

    await invokeShortcut();
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ▶ · 1.25×`);
    assert.equal(lastNotification().message, "Talking; waiting for the newest message to finish");

    await invokeShortcut();
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ⏸ · 1.25×`);
    assert.equal(lastNotification().message, "Speech paused at the current position");

    await invokeShortcut();
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ▶ · 1.25×`);
    assert.equal(lastNotification().message, "Speech continued from the paused position");

    await commands.get("gag")?.handler("", context);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ■ · 1.25×`);
    await commands.get("talk")?.handler("", context);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ▶ · 1.25×`);
    await invokeShortcut();
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ⏸ · 1.25×`);
    await commands.get("unpause")?.handler("", context);
    assert.equal(lastStatus(), `${OPENAI_SPEECH_MODEL} · ▶ · 1.25×`);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
    if (previousSpeed === undefined) delete process.env.PI_TALK_SPEED;
    else process.env.PI_TALK_SPEED = previousSpeed;
  }
});
