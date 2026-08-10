import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { SpeechCancelledError, SpeechError } from "../src/speech.ts";
import {
  KILL_GRACE_MS,
  PAUSE_SIGNAL,
  RESUME_SIGNAL,
  TERM_GRACE_MS,
  claimSpeaker,
  clearSpeakerRecord,
  isSpeakerRecordLive,
  parseSecretsEnv,
  readSpeakerRecord,
  resolveApiKey,
  resolvePlaybackSpeed,
  runSpeakerCli,
  sanitizeFailure,
  signalSpeaker,
  speakText,
  speakerLogPath,
  speakerPidPath,
  writeSpeakerRecord,
  type ProcessDescription,
  type ProcessProbe,
  type SpeakerEnvironment,
  type SpeakerFileSystem,
  type SpeakerPlayback,
} from "../src/speaker.ts";

const STATE_DIR = "/state/cc-talk";
const SPEAKER_COMMAND = "node /repo/bin/cc-talk-speak --daemon";

type MemoryFileSystem = SpeakerFileSystem & {
  readonly entries: Map<string, string>;
  readonly directories: Set<string>;
};

function memoryFileSystem(): MemoryFileSystem {
  const entries = new Map<string, string>();
  const directories = new Set<string>();

  return {
    entries,
    directories,
    ensureDirectory(path) {
      directories.add(path);
    },
    readText(path) {
      return entries.get(path);
    },
    writeText(path, contents) {
      entries.set(path, contents);
    },
    appendText(path, contents) {
      entries.set(path, (entries.get(path) ?? "") + contents);
    },
    remove(path) {
      entries.delete(path);
    },
  };
}

type FakeProcess = {
  pgid: number;
  command: string;
  diesOn: "SIGTERM" | "SIGKILL" | "never";
};

class FakeProbe implements ProcessProbe {
  readonly processes = new Map<number, FakeProcess>();
  readonly groupSignals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  readonly processSignals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  add(pid: number, options: Partial<FakeProcess> = {}): void {
    this.processes.set(pid, {
      pgid: options.pgid ?? pid,
      command: options.command ?? SPEAKER_COMMAND,
      diesOn: options.diesOn ?? "SIGTERM",
    });
  }

  isAlive(pid: number): boolean {
    return this.processes.has(pid);
  }

  describe(pid: number): ProcessDescription | undefined {
    const found = this.processes.get(pid);
    return found ? { pgid: found.pgid, command: found.command } : undefined;
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): void {
    this.groupSignals.push({ pgid, signal });
    for (const [pid, found] of [...this.processes]) {
      if (found.pgid !== pgid || found.diesOn === "never") continue;
      if (signal === "SIGKILL" || found.diesOn === signal) this.processes.delete(pid);
    }
  }

  signalProcess(pid: number, signal: NodeJS.Signals): void {
    this.processSignals.push({ pid, signal });
  }

  get signalNames(): NodeJS.Signals[] {
    return this.groupSignals.map((entry) => entry.signal);
  }
}

class FakeDaemon extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly chunks: Buffer[] = [];
  unrefCount = 0;

  constructor() {
    super();
    this.stdin.on("data", (chunk) => this.chunks.push(Buffer.from(chunk)));
  }

  unref(): this {
    this.unrefCount += 1;
    return this;
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

class FakePlayback implements SpeakerPlayback {
  readonly spoken: string[] = [];
  readonly speeds: number[] = [];
  /** Every setPaused the daemon drove, in order. */
  readonly pausedCalls: boolean[] = [];
  cancelCount = 0;
  private pending?: (error: unknown) => void;
  private readonly hold: boolean;

  constructor(hold = false) {
    this.hold = hold;
  }

  get paused(): boolean {
    return this.pausedCalls.at(-1) ?? false;
  }

  pause(): Promise<void> {
    this.pausedCalls.push(true);
    return Promise.resolve();
  }

  resume(): Promise<void> {
    this.pausedCalls.push(false);
    return Promise.resolve();
  }

  playChunk(text: string, playbackSpeed: number): Promise<void> {
    this.spoken.push(text);
    this.speeds.push(playbackSpeed);
    if (!this.hold) return Promise.resolve();
    return new Promise<void>((_resolve, reject) => {
      this.pending = reject;
    });
  }

  cancel(): Promise<void> {
    this.cancelCount += 1;
    const reject = this.pending;
    this.pending = undefined;
    reject?.(new SpeechCancelledError());
    return Promise.resolve();
  }
}

type Harness = {
  environment: SpeakerEnvironment;
  files: MemoryFileSystem;
  probe: FakeProbe;
  stdout: string[];
  stderr: string[];
};

function harness(overrides: Partial<SpeakerEnvironment> = {}): Harness {
  const files = memoryFileSystem();
  const probe = new FakeProbe();
  const stdout: string[] = [];
  const stderr: string[] = [];

  const base: SpeakerEnvironment = {
    env: { CC_TALK_STATE_DIR: STATE_DIR, HOME: "/home/test", OPENAI_API_KEY: "test-key" },
    files,
    probe,
    signals: new EventEmitter(),
    stdin: Readable.from([]),
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
    entryScript: "/repo/bin/cc-talk-speak",
    pid: 777,
    now: () => 1_700_000_000_000,
    sleep: async () => undefined,
    spawnDaemon: () => {
      throw new Error("spawnDaemon was not stubbed");
    },
    createPlayback: () => {
      throw new Error("createPlayback was not stubbed");
    },
  };

  return {
    environment: { ...base, ...overrides, env: { ...base.env, ...(overrides.env ?? {}) } },
    files,
    probe,
    stdout,
    stderr,
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) resolve();
      else if (Date.now() - started >= timeoutMs) reject(new Error("condition timed out"));
      else setTimeout(check, 1);
    };
    check();
  });
}

test("the teardown ladder mirrors the speech engine grace periods", () => {
  assert.equal(TERM_GRACE_MS, 250);
  assert.equal(KILL_GRACE_MS, 1_000);
});

test("claiming the speaker terminates the previous group and records the newcomer", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242);
  probe.add(777);

  const record = await claimSpeaker(environment, STATE_DIR);

  assert.deepEqual(probe.groupSignals, [{ pgid: 4_242, signal: "SIGTERM" }]);
  assert.equal(probe.isAlive(4_242), false);
  assert.deepEqual(record, { pid: 777, pgid: 777, startedAt: 1_700_000_000_000 });
  assert.deepEqual(readSpeakerRecord(STATE_DIR, files), record);
});

test("claiming escalates to SIGKILL when the previous group ignores SIGTERM", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242, { diesOn: "SIGKILL" });
  probe.add(777);

  await claimSpeaker(environment, STATE_DIR);

  assert.deepEqual(probe.signalNames, ["SIGTERM", "SIGKILL"]);
  assert.equal(readSpeakerRecord(STATE_DIR, files)?.pid, 777);
});

test("a reused pid is not mistaken for a live speaker", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242, { pgid: 900, command: "vim notes.md" });
  probe.add(777);

  assert.equal(isSpeakerRecordLive({ pid: 4_242, pgid: 4_242, startedAt: 1 }, probe), false);

  await claimSpeaker(environment, STATE_DIR);

  assert.deepEqual(probe.groupSignals, []);
  assert.equal(probe.isAlive(4_242), true);
  assert.equal(readSpeakerRecord(STATE_DIR, files)?.pid, 777);
});

test("a pidfile for a dead process is claimed without signalling anything", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(777);

  await claimSpeaker(environment, STATE_DIR);

  assert.deepEqual(probe.groupSignals, []);
  assert.equal(readSpeakerRecord(STATE_DIR, files)?.pid, 777);
});

test("a corrupt pidfile is ignored rather than signalled", async () => {
  const { environment, files, probe } = harness();
  files.writeText(speakerPidPath(STATE_DIR), "not json at all");

  assert.equal(readSpeakerRecord(STATE_DIR, files), undefined);
  await claimSpeaker(environment, STATE_DIR);

  assert.deepEqual(probe.groupSignals, []);
  assert.equal(readSpeakerRecord(STATE_DIR, files)?.pid, 777);
});

test("--stop runs the ladder and clears the pidfile", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242, { diesOn: "SIGKILL" });

  assert.equal(await runSpeakerCli(["--stop"], environment), 0);

  assert.deepEqual(probe.groupSignals, [
    { pgid: 4_242, signal: "SIGTERM" },
    { pgid: 4_242, signal: "SIGKILL" },
  ]);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), false);
});

test("--stop succeeds when nothing is playing", async () => {
  const { environment, probe, stderr } = harness();

  assert.equal(await runSpeakerCli(["--stop"], environment), 0);
  assert.deepEqual(probe.groupSignals, []);
  assert.deepEqual(stderr, []);
});

test("a departing speaker never deletes a newer speaker's pidfile", () => {
  const { files } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 999, pgid: 999, startedAt: 2 });

  clearSpeakerRecord(STATE_DIR, files, 777);
  assert.equal(readSpeakerRecord(STATE_DIR, files)?.pid, 999);

  clearSpeakerRecord(STATE_DIR, files, 999);
  assert.equal(readSpeakerRecord(STATE_DIR, files), undefined);
});

test("parseSecretsEnv reads export lines, quotes, and skips comments", () => {
  const parsed = parseSecretsEnv(
    [
      "# comment",
      "",
      "export OPENAI_API_KEY=sk-plain-value",
      `export QUOTED="sk-quoted-value"`,
      "export SINGLE='sk-single-value'",
      "BARE=bare-value",
      "not a definition",
    ].join("\n"),
  );

  assert.deepEqual(parsed, {
    OPENAI_API_KEY: "sk-plain-value",
    QUOTED: "sk-quoted-value",
    SINGLE: "sk-single-value",
    BARE: "bare-value",
  });
});

test("resolveApiKey prefers the environment and falls back to ~/.secrets/env", () => {
  assert.equal(resolveApiKey({ OPENAI_API_KEY: "sk-env" }, () => "export OPENAI_API_KEY=sk-file"), "sk-env");
  assert.equal(resolveApiKey({ OPENAI_API_KEY: "  " }, () => "export OPENAI_API_KEY=sk-file"), "sk-file");
  assert.throws(
    () => resolveApiKey({}, () => undefined),
    (error) => sanitizeFailure(error) === "configuration: OPENAI_API_KEY is not set and ~/.secrets/env does not define it.",
  );
  assert.throws(() => resolveApiKey({}, () => "export OTHER=value"), /OPENAI_API_KEY/);
});

test("resolvePlaybackSpeed defaults to 1.25 and rejects out-of-bounds values", () => {
  assert.equal(resolvePlaybackSpeed({}), 1.25);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "  " }), 1.25);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "1.75" }), 1.75);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "0.50" }), 0.5);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "3.00" }), 3);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "0.10" }), 1.25);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "9" }), 1.25);
  assert.equal(resolvePlaybackSpeed({ PI_TALK_SPEED: "fast" }), 1.25);
});

test("--file reads the request, unlinks it, and hands the text to a detached daemon", async () => {
  const daemons: FakeDaemon[] = [];
  const spawned: string[][] = [];
  const { environment, files } = harness({
    spawnDaemon: (argv) => {
      spawned.push(argv);
      const daemon = new FakeDaemon();
      daemons.push(daemon);
      return daemon as unknown as ChildProcess;
    },
  });
  files.writeText("/tmp/request.txt", "Speak this aloud, please.");

  assert.equal(await runSpeakerCli(["--file", "/tmp/request.txt"], environment), 0);

  assert.equal(files.entries.has("/tmp/request.txt"), false);
  assert.deepEqual(spawned, [["/repo/bin/cc-talk-speak", "--daemon"]]);
  assert.equal(daemons[0].text, "Speak this aloud, please.");
  assert.equal(daemons[0].unrefCount, 1);
});

test("--file reports a sanitized failure when the request cannot be read", async () => {
  const { environment, files, stderr } = harness();

  assert.equal(await runSpeakerCli(["--file", "/tmp/missing.txt"], environment), 1);
  assert.match(stderr.join(""), /The speech input file could not be read\./);
  assert.match(files.entries.get(speakerLogPath(STATE_DIR)) ?? "", /input: The speech input file could not be read\./);
});

test("--file without a path is a usage error", async () => {
  const { environment, stderr } = harness();

  assert.equal(await runSpeakerCli(["--file"], environment), 2);
  assert.match(stderr.join(""), /--file requires a path\./);
});

test("stdin mode forwards the text to a detached daemon", async () => {
  const daemons: FakeDaemon[] = [];
  const { environment } = harness({
    stdin: Readable.from(["Hello ", "from stdin."]),
    spawnDaemon: () => {
      const daemon = new FakeDaemon();
      daemons.push(daemon);
      return daemon as unknown as ChildProcess;
    },
  });

  assert.equal(await runSpeakerCli([], environment), 0);
  assert.equal(daemons[0].text, "Hello from stdin.");
});

test("blank input never spawns a daemon", async () => {
  let spawns = 0;
  const { environment } = harness({
    stdin: Readable.from(["   \n"]),
    spawnDaemon: () => {
      spawns += 1;
      throw new Error("unreachable");
    },
  });

  assert.equal(await runSpeakerCli([], environment), 0);
  assert.equal(spawns, 0);
});

test("the daemon claims the speaker, speaks every chunk, then releases the pidfile", async () => {
  const playback = new FakePlayback();
  const { environment, files, probe } = harness({
    stdin: Readable.from(["Alpha. \\(x + y\\) Omega."]),
    env: { PI_TALK_SPEED: "1.75" },
    createPlayback: () => playback,
  });
  probe.add(777, { pgid: 777 });

  assert.equal(await runSpeakerCli(["--daemon"], environment), 0);

  assert.deepEqual(playback.spoken, ["Alpha. Omega."]);
  assert.deepEqual(playback.speeds, [1.75]);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), false);
  assert.equal(files.entries.has(speakerLogPath(STATE_DIR)), false);
});

test("SIGTERM cancels the daemon gracefully and exits quietly", async () => {
  const playback = new FakePlayback(true);
  const signals = new EventEmitter();
  const { environment, files } = harness({
    stdin: Readable.from(["A long answer that is still playing."]),
    signals,
    createPlayback: () => playback,
  });

  const pending = runSpeakerCli(["--daemon"], environment);
  await waitFor(() => playback.spoken.length === 1);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), true);

  signals.emit("SIGTERM");

  assert.equal(await pending, 0);
  assert.equal(playback.cancelCount, 1);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), false);
  assert.equal(files.entries.has(speakerLogPath(STATE_DIR)), false);
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("provider failures reach the log as sanitized one-liners", async () => {
  const secret = "sk-do-not-log-this";
  const { environment, files, stderr } = harness({
    stdin: Readable.from(["Confidential spoken sentence."]),
    env: { OPENAI_API_KEY: secret },
    createPlayback: () => ({
      playChunk: () =>
        Promise.reject(
          new SpeechError("rate_limit", "Speech temporarily unavailable (rate limited or timed out).", "raw provider body", {
            status: 429,
            requestId: "req_test",
          }),
        ),
      cancel: () => Promise.resolve(),
    }),
  });

  assert.equal(await runSpeakerCli(["--daemon"], environment), 1);

  const log = files.entries.get(speakerLogPath(STATE_DIR)) ?? "";
  assert.match(log, /rate_limit: Speech temporarily unavailable \(rate limited or timed out\)\./);
  assert.equal(log.trim().split("\n").length, 1);
  assert.ok(!log.includes(secret));
  assert.ok(!log.includes("raw provider body"));
  assert.ok(!log.includes("Confidential spoken sentence."));
  assert.deepEqual(stderr, []);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), false);
});

test("a missing API key fails before any playback and never echoes the secrets file", async () => {
  let created = 0;
  const { environment, files } = harness({
    stdin: Readable.from(["Anything at all."]),
    env: { OPENAI_API_KEY: "" },
    createPlayback: () => {
      created += 1;
      throw new Error("unreachable");
    },
  });
  files.writeText("/home/test/.secrets/env", "export UNRELATED=sk-other-secret");

  assert.equal(await runSpeakerCli(["--daemon"], environment), 1);

  assert.equal(created, 0);
  const log = files.entries.get(speakerLogPath(STATE_DIR)) ?? "";
  assert.match(log, /configuration: OPENAI_API_KEY is not set/);
  assert.ok(!log.includes("sk-other-secret"));
});

test("the daemon accepts the API key from ~/.secrets/env", async () => {
  const playback = new FakePlayback();
  const keys: string[] = [];
  const { environment, files } = harness({
    stdin: Readable.from(["Fallback key path."]),
    env: { OPENAI_API_KEY: "" },
    createPlayback: (apiKey) => {
      keys.push(apiKey);
      return playback;
    },
  });
  files.writeText("/home/test/.secrets/env", "export OPENAI_API_KEY=sk-from-secrets\n");

  assert.equal(await runSpeakerCli(["--daemon"], environment), 0);
  assert.deepEqual(keys, ["sk-from-secrets"]);
  assert.deepEqual(playback.spoken, ["Fallback key path."]);
});

test("speakText strips math, orders chunks, and stops once cancelled", async () => {
  const playback = new FakePlayback();
  const long = Array.from({ length: 400 }, (_, index) => `Sentence ${index} about $$x$$ things.`).join(" ");

  await speakText(long, playback, 1.25);
  assert.ok(playback.spoken.length > 1);
  assert.ok(playback.spoken.every((chunk) => !chunk.includes("$$")));

  const stopping = new FakePlayback();
  let cancelled = false;
  await speakText(
    long,
    {
      playChunk: (text, speed) => {
        cancelled = true;
        return stopping.playChunk(text, speed);
      },
      cancel: () => stopping.cancel(),
    },
    1.25,
    () => cancelled,
  );
  assert.equal(stopping.spoken.length, 1);
});

test("the speaker path never speaks fenced code, URLs, or markdown syntax", async () => {
  const playback = new FakePlayback();
  const markdown = [
    "Here is the **fix**:",
    "```typescript",
    "async function teardown() {",
    "  await player.kill();",
    "}",
    "```",
    "Call `teardown()` first.",
  ].join("\n");

  await speakText(markdown, playback, 1.25);

  assert.deepEqual(playback.spoken, ["Here is the fix: Call teardown() first."]);
});

test("the daemon speaks the same cleaned text the Pi extension would", async () => {
  const playback = new FakePlayback();
  const { environment, probe } = harness({
    stdin: Readable.from(["## Notes\n\n```sh\nrm -rf /\n```\n\nSee https://example.com/x for details."]),
    createPlayback: () => playback,
  });
  probe.add(777, { pgid: 777 });

  assert.equal(await runSpeakerCli(["--daemon"], environment), 0);

  assert.deepEqual(playback.spoken, ["Notes See for details."]);
});

test("SIGUSR1 and SIGUSR2 freeze and continue the daemon without tearing it down", async () => {
  const playback = new FakePlayback(true);
  const signals = new EventEmitter();
  const { environment, files } = harness({
    stdin: Readable.from(["A long answer that is still playing."]),
    signals,
    createPlayback: () => playback,
  });

  const pending = runSpeakerCli(["--daemon"], environment);
  await waitFor(() => playback.spoken.length === 1);

  signals.emit(PAUSE_SIGNAL);
  await waitFor(() => playback.paused);
  assert.equal(playback.cancelCount, 0);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), true);

  signals.emit(RESUME_SIGNAL);
  await waitFor(() => !playback.paused);
  assert.deepEqual(playback.pausedCalls, [true, false]);
  assert.equal(playback.cancelCount, 0);

  signals.emit("SIGTERM");
  assert.equal(await pending, 0);
  assert.equal(signals.listenerCount(PAUSE_SIGNAL), 0);
  assert.equal(signals.listenerCount(RESUME_SIGNAL), 0);
});

test("--pause and --unpause signal the daemon pid alone, never the group", async () => {
  const { environment, files, probe } = harness();
  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242);

  assert.equal(await runSpeakerCli(["--pause"], environment), 0);
  assert.equal(await runSpeakerCli(["--unpause"], environment), 0);

  assert.deepEqual(probe.processSignals, [
    { pid: 4_242, signal: "SIGUSR1" },
    { pid: 4_242, signal: "SIGUSR2" },
  ]);
  assert.deepEqual(probe.groupSignals, []);
  assert.equal(probe.isAlive(4_242), true);
  assert.equal(files.entries.has(speakerPidPath(STATE_DIR)), true);
});

test("--pause and --unpause exit 0 silently when no live speaker holds the pidfile", async () => {
  const absent = harness();
  assert.equal(await runSpeakerCli(["--pause"], absent.environment), 0);
  assert.equal(await runSpeakerCli(["--unpause"], absent.environment), 0);
  assert.deepEqual(absent.probe.processSignals, []);
  assert.deepEqual(absent.stderr, []);

  const stale = harness();
  writeSpeakerRecord(STATE_DIR, stale.files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  assert.equal(await runSpeakerCli(["--pause"], stale.environment), 0);
  assert.deepEqual(stale.probe.processSignals, []);
  assert.deepEqual(stale.stderr, []);

  const reused = harness();
  writeSpeakerRecord(STATE_DIR, reused.files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  reused.probe.add(4_242, { pgid: 900, command: "vim notes.md" });
  assert.equal(await runSpeakerCli(["--pause"], reused.environment), 0);
  assert.deepEqual(reused.probe.processSignals, []);
  assert.deepEqual(reused.stderr, []);
});

test("a paused speaker still dies to --stop and to a takeover", async () => {
  const stopped = harness();
  writeSpeakerRecord(STATE_DIR, stopped.files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  stopped.probe.add(4_242);

  assert.equal(await runSpeakerCli(["--pause"], stopped.environment), 0);
  assert.equal(await runSpeakerCli(["--stop"], stopped.environment), 0);

  assert.deepEqual(stopped.probe.groupSignals, [{ pgid: 4_242, signal: "SIGTERM" }]);
  assert.equal(stopped.probe.isAlive(4_242), false);
  assert.equal(stopped.files.entries.has(speakerPidPath(STATE_DIR)), false);

  const taken = harness();
  writeSpeakerRecord(STATE_DIR, taken.files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  taken.probe.add(4_242);
  taken.probe.add(777);

  assert.equal(await runSpeakerCli(["--pause"], taken.environment), 0);
  await claimSpeaker(taken.environment, STATE_DIR);

  assert.deepEqual(taken.probe.groupSignals, [{ pgid: 4_242, signal: "SIGTERM" }]);
  assert.equal(taken.probe.isAlive(4_242), false);
  assert.equal(readSpeakerRecord(STATE_DIR, taken.files)?.pid, 777);
});

test("--help lists the pause verbs", async () => {
  const { environment, stdout } = harness();

  assert.equal(await runSpeakerCli(["--help"], environment), 0);
  assert.match(stdout.join(""), /--pause\s+freeze the current speaker/);
  assert.match(stdout.join(""), /--unpause\s+continue a frozen speaker/);
});

test("signalSpeaker reports whether a live speaker received the signal", () => {
  const { environment, files, probe } = harness();
  assert.equal(signalSpeaker(environment, STATE_DIR, PAUSE_SIGNAL), false);

  writeSpeakerRecord(STATE_DIR, files, { pid: 4_242, pgid: 4_242, startedAt: 1 });
  probe.add(4_242);
  assert.equal(signalSpeaker(environment, STATE_DIR, PAUSE_SIGNAL), true);
});

test("unknown errors never leak their message into the log", () => {
  assert.equal(sanitizeFailure(new Error("/Users/someone/.secrets/env is unreadable")), "unexpected: cc-talk-speak failed");
});
