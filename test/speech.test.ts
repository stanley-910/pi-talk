import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  MAX_SPEECH_CHUNK_BYTES,
  OPENAI_SPEECH_MODEL,
  OPENAI_SPEECH_VOICE,
  OpenAISpeechPlayback,
  SpeechCancelledError,
  SpeechError,
  splitSpeechText,
  stripDelimitedMath,
  type PlayerProcess,
} from "../src/speech.ts";

type FakePlayerBehavior = {
  closeOnInputEnd?: boolean;
  closeOnTerm?: boolean;
  closeOnKill?: boolean;
  stdinHighWaterMark?: number;
  forceBackpressureOnce?: boolean;
  emitStdinErrorOnce?: boolean;
  errorOnTerm?: boolean;
  ipcErrorOnce?: boolean;
  ignoreIpc?: boolean;
};

class FakePlayer extends EventEmitter implements PlayerProcess {
  readonly stdin: PassThrough;
  readonly stderr = new PassThrough();
  readonly control = new PassThrough();
  readonly signals: NodeJS.Signals[] = [];
  readonly audio: Buffer[] = [];
  readonly commands: unknown[][] = [];
  pid: number | undefined = 1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  backpressureCount = 0;
  private readonly behavior: FakePlayerBehavior;

  constructor(behavior: FakePlayerBehavior = {}) {
    super();
    this.behavior = behavior;
    this.stdin = new PassThrough({ highWaterMark: behavior.stdinHighWaterMark });
    const write = this.stdin.write.bind(this.stdin);
    let forceBackpressure = behavior.forceBackpressureOnce === true;
    let emitStdinError = behavior.emitStdinErrorOnce === true;
    this.stdin.write = ((...args: Parameters<PassThrough["write"]>) => {
      const accepted = write(...args);
      if (emitStdinError) {
        emitStdinError = false;
        queueMicrotask(() => {
          const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
          this.stdin.emit("error", error);
        });
      }
      if (forceBackpressure) {
        forceBackpressure = false;
        this.backpressureCount += 1;
        queueMicrotask(() => this.stdin.emit("drain"));
        return false;
      }
      if (!accepted) this.backpressureCount += 1;
      return accepted;
    }) as PassThrough["write"];
    this.stdin.on("data", (chunk) => this.audio.push(Buffer.from(chunk)));
    this.stdin.on("finish", () => {
      if (this.behavior.closeOnInputEnd !== false) this.close(0, null);
    });

    let ipcError = behavior.ipcErrorOnce === true;
    this.control.write = ((chunk: string | Uint8Array) => {
      const message = JSON.parse(String(chunk));
      this.commands.push(message.command);
      if (!this.behavior.ignoreIpc) {
        queueMicrotask(() => {
          this.control.emit(
            "data",
            Buffer.from(
              `${JSON.stringify({
                request_id: message.request_id,
                error: ipcError ? "property unavailable" : "success",
              })}\n`,
            ),
          );
          ipcError = false;
        });
      }
      return true;
    }) as PassThrough["write"];
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    if (signal === "SIGTERM" && this.behavior.errorOnTerm) {
      queueMicrotask(() => this.emit("error", new Error("kill failed")));
      return false;
    }
    if (signal === "SIGTERM" && this.behavior.closeOnTerm !== false) this.close(null, signal);
    if (signal === "SIGKILL" && this.behavior.closeOnKill !== false) this.close(null, signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    queueMicrotask(() => this.emit("close", code, signal));
  }
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

function playbackWith(
  fetcher: typeof fetch,
  players: FakePlayer[],
  behavior?: ConstructorParameters<typeof FakePlayer>[0],
  timeoutOverrides: Partial<{
    headerMs: number;
    bodyIdleMs: number;
    controlMs: number;
    totalMs: number;
    termGraceMs: number;
    killGraceMs: number;
  }> = {},
) {
  return new OpenAISpeechPlayback({
    apiKey: "test-key",
    fetcher,
    spawnPlayer: () => {
      const player = new FakePlayer(behavior);
      players.push(player);
      return player;
    },
    timeouts: {
      headerMs: 100,
      bodyIdleMs: 100,
      totalMs: 500,
      termGraceMs: 5,
      killGraceMs: 20,
      ...timeoutOverrides,
    },
  });
}

test("splitSpeechText preserves order and bounds UTF-8 chunks", () => {
  const text = Array.from({ length: 500 }, (_, index) => `Sentence ${index} café 漢字.`).join(" ");
  const chunks = splitSpeechText(text);

  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_SPEECH_CHUNK_BYTES));
  assert.ok(chunks.every((chunk) => chunk.length > 0));
});

test("splitSpeechText never splits a Unicode scalar", () => {
  const text = "🙂".repeat(MAX_SPEECH_CHUNK_BYTES);
  const chunks = splitSpeechText(text);

  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => !chunk.includes("�")));
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= MAX_SPEECH_CHUNK_BYTES));
});

test("stripDelimitedMath removes math without swallowing currency prose", () => {
  assert.equal(
    stripDelimitedMath("It costs $5 and the alternative costs $10."),
    "It costs $5 and the alternative costs $10.",
  );
  assert.equal(stripDelimitedMath("Use $x + y$ and \\(z\\), then pay $5."), "Use   and  , then pay $5.");
  assert.equal(stripDelimitedMath("Before $$x + y$$ after."), "Before   after.");
});

test("playChunk sends the pinned request and streams WAV bytes to mpv", async () => {
  const players: FakePlayer[] = [];
  let request: { url: string; init: RequestInit } | undefined;
  let spawnedCommand: string | undefined;
  let spawnedArgs: string[] | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2]));
      setTimeout(() => {
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      }, 2);
    },
  });
  const playback = new OpenAISpeechPlayback({
    apiKey: "test-key",
    fetcher: async (url, init) => {
      request = { url: String(url), init: init ?? {} };
      return new Response(body, { status: 200 });
    },
    spawnPlayer: (command, args) => {
      spawnedCommand = command;
      spawnedArgs = args;
      const player = new FakePlayer();
      players.push(player);
      return player;
    },
    timeouts: { headerMs: 100, bodyIdleMs: 100, totalMs: 500, termGraceMs: 5, killGraceMs: 20 },
  });

  await playback.playChunk("hello", 1.25);

  assert.equal(request?.url, "https://api.openai.com/v1/audio/speech");
  assert.equal(request?.init.method, "POST");
  assert.deepEqual(JSON.parse(String(request?.init.body)), {
    model: OPENAI_SPEECH_MODEL,
    voice: OPENAI_SPEECH_VOICE,
    input: "hello",
    response_format: "wav",
    stream_format: "audio",
    speed: 1,
  });
  assert.equal(new Headers(request?.init.headers).get("authorization"), "Bearer test-key");
  assert.equal(spawnedCommand, "mpv");
  assert.deepEqual(spawnedArgs, [
    "--no-config",
    "--no-video",
    "--no-terminal",
    "--msg-level=all=error",
    "--input-ipc-client=fd://3",
    "--audio-pitch-correction=yes",
    "--speed=1.25",
    "--demuxer-lavf-format=wav",
    "--pause=no",
    "-",
  ]);
  assert.deepEqual(Buffer.concat(players[0].audio), Buffer.from([1, 2, 3, 4]));
  assert.equal(playback.hasActivePlayback, false);
});

test("playChunk waits for player backpressure before continuing", async () => {
  const players: FakePlayer[] = [];
  const audio = Uint8Array.from({ length: 4_096 }, (_, index) => index % 256);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(audio);
      controller.close();
    },
  });
  const playback = new OpenAISpeechPlayback({
    apiKey: "test-key",
    fetcher: async () => new Response(body),
    spawnPlayer: () => {
      const player = new FakePlayer({ forceBackpressureOnce: true });
      players.push(player);
      return player;
    },
  });

  await playback.playChunk("hello", 1);

  assert.ok(players[0].backpressureCount > 0);
  assert.deepEqual(Buffer.concat(players[0].audio), Buffer.from(audio));
});

test("an asynchronous player stdin error becomes a sanitized playback failure", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, {
    emitStdinErrorOnce: true,
  });

  await assert.rejects(
    playback.playChunk("hello", 1),
    (error) => error instanceof SpeechError && error.code === "playback" && !error.message.includes("broken pipe"),
  );
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("a player spawn error is actionable and does not wait for close", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = new OpenAISpeechPlayback({
    apiKey: "test-key",
    fetcher: async () => new Response(body),
    spawnPlayer: () => {
      const player = new FakePlayer();
      player.pid = undefined;
      players.push(player);
      queueMicrotask(() => player.emit("error", new Error("ENOENT: secret path")));
      return player;
    },
  });

  await assert.rejects(
    playback.playChunk("hello", 1),
    (error) =>
      error instanceof SpeechError &&
      error.code === "player_unavailable" &&
      !error.userMessage.includes("secret path"),
  );
  assert.deepEqual(players[0].signals, []);
});

test("cancel aborts a request before headers without spawning a player", async () => {
  const players: FakePlayer[] = [];
  let aborted = false;
  const playback = playbackWith(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
    players,
  );

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => playback.hasActivePlayback);
  await playback.cancel();

  await assert.rejects(pending, SpeechCancelledError);
  assert.equal(aborted, true);
  assert.equal(players.length, 0);
  assert.equal(playback.hasActivePlayback, false);
});

test("cancel closes stdin and terminates a playing child before returning", async () => {
  const players: FakePlayer[] = [];
  let bodyCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3]));
    },
    cancel() {
      bodyCancelled = true;
    },
  });
  const playback = playbackWith(async () => new Response(body), players);

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1 && players[0].audio.length > 0);
  await playback.cancel();

  await assert.rejects(pending, SpeechCancelledError);
  assert.equal(bodyCancelled, true);
  assert.equal(players[0].stdin.destroyed, true);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("cancel does not wait for a non-settling response-stream cancellation", async () => {
  const players: FakePlayer[] = [];
  let cancellationStarted = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
    cancel() {
      cancellationStarted = true;
      return new Promise<void>(() => undefined);
    },
  });
  const playback = playbackWith(async () => new Response(body), players);

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1);
  await Promise.race([
    playback.cancel(),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("cancel hung")), 100)),
  ]);

  await assert.rejects(pending, SpeechCancelledError);
  assert.equal(cancellationStarted, true);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("pause and resume use mpv IPC without suspending the player process", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players);

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1);
  await playback.pause();
  await playback.resume();

  assert.deepEqual(players[0].commands, [
    ["set_property", "pause", true],
    ["set_property", "pause", false],
  ]);
  assert.deepEqual(players[0].signals, []);

  await playback.cancel();
  await assert.rejects(pending, SpeechCancelledError);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("mpv control failures are sanitized and stop playback safely", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, { ipcErrorOnce: true });

  const pending = playback.playChunk("hello", 1);
  void pending.catch(() => undefined);
  await waitFor(() => players.length === 1);
  await assert.rejects(
    playback.pause(),
    (error) =>
      error instanceof SpeechError && error.code === "playback" && !error.message.includes("property unavailable"),
  );
  await assert.rejects(pending, (error) => error instanceof SpeechError && error.code === "playback");
  assert.equal(players[0].control.destroyed, true);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("mpv control timeout is sanitized and stops playback safely", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(
    async () => new Response(body),
    players,
    { ignoreIpc: true },
    { controlMs: 5 },
  );

  const pending = playback.playChunk("hello", 1);
  void pending.catch(() => undefined);
  await waitFor(() => players.length === 1);
  await assert.rejects(
    playback.pause(),
    (error) => error instanceof SpeechError && error.code === "playback" && !error.message.includes("timed out"),
  );
  await assert.rejects(pending, (error) => error instanceof SpeechError && error.code === "playback");
  assert.equal(players[0].control.destroyed, true);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("cancellation silently interrupts a pending mpv control command", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, { ignoreIpc: true });

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1);
  const pausing = playback.pause();
  void pausing.catch(() => undefined);
  await waitFor(() => players[0].commands.length === 1);
  await playback.cancel();

  await assert.rejects(pausing, SpeechCancelledError);
  await assert.rejects(pending, SpeechCancelledError);
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("cancel escalates to SIGKILL when SIGTERM is ignored", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, {
    closeOnTerm: false,
    closeOnKill: true,
  });

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1);
  await playback.cancel();

  await assert.rejects(pending, SpeechCancelledError);
  assert.deepEqual(players[0].signals, ["SIGTERM", "SIGKILL"]);
});

test("a kill error does not masquerade as process close", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, {
    errorOnTerm: true,
    closeOnKill: true,
  });

  const pending = playback.playChunk("hello", 1);
  await waitFor(() => players.length === 1);
  await playback.cancel();
  await assert.rejects(pending, SpeechCancelledError);
  assert.deepEqual(players[0].signals, ["SIGTERM", "SIGKILL"]);
});

test("header timeout aborts once and does not retry", async () => {
  const players: FakePlayer[] = [];
  let calls = 0;
  const playback = playbackWith(
    (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    },
    players,
    undefined,
    { headerMs: 5 },
  );

  await assert.rejects(
    playback.playChunk("hello", 1),
    (error) => error instanceof SpeechError && error.code === "timeout" && !error.message.includes("hello"),
  );
  assert.equal(calls, 1);
  assert.equal(players.length, 0);
});

test("body idle timeout tears down the player", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
    },
  });
  const playback = playbackWith(async () => new Response(body), players, undefined, { bodyIdleMs: 5 });

  await assert.rejects(
    playback.playChunk("hello", 1),
    (error) => error instanceof SpeechError && error.code === "timeout",
  );
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("total deadline includes waiting for player close", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
      controller.close();
    },
  });
  const playback = playbackWith(
    async () => new Response(body),
    players,
    { closeOnInputEnd: false, closeOnTerm: true },
    { totalMs: 5 },
  );

  await assert.rejects(
    playback.playChunk("hello", 1),
    (error) => error instanceof SpeechError && error.code === "timeout",
  );
  assert.deepEqual(players[0].signals, ["SIGTERM"]);
});

test("failed SIGKILL cleanup blocks later playback", async () => {
  const players: FakePlayer[] = [];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1]));
      controller.close();
    },
  });
  const playback = playbackWith(async () => new Response(body), players, {
    closeOnInputEnd: false,
    closeOnTerm: false,
    closeOnKill: false,
  });

  const pending = playback.playChunk("first", 1);
  await waitFor(() => players.length === 1);
  const cancellation = playback.cancel();
  const [playResult, cancelResult] = await Promise.allSettled([pending, cancellation]);

  assert.equal(playResult.status, "rejected");
  assert.equal(cancelResult.status, "rejected");
  assert.ok(cancelResult.reason instanceof SpeechError);
  assert.equal(cancelResult.reason.code, "cleanup");
  await assert.rejects(
    playback.playChunk("second", 1),
    (error) => error instanceof SpeechError && error.code === "cleanup",
  );
  assert.equal(players.length, 1);
});

test("provider errors are sanitized and never retried", async () => {
  const players: FakePlayer[] = [];
  let calls = 0;
  const playback = playbackWith(async () => {
    calls += 1;
    return new Response('{"error":"raw secret customer text"}', {
      status: 429,
      headers: { "x-request-id": "req_test" },
    });
  }, players);

  await assert.rejects(
    playback.playChunk("spoken secret", 1),
    (error) =>
      error instanceof SpeechError &&
      error.code === "rate_limit" &&
      error.requestId === "req_test" &&
      !error.message.includes("raw secret") &&
      !error.message.includes("spoken secret"),
  );
  assert.equal(calls, 1);
  assert.equal(players.length, 0);
});

test("a second play cannot overlap an active request", async () => {
  const players: FakePlayer[] = [];
  const playback = playbackWith(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    players,
  );

  const pending = playback.playChunk("first", 1);
  await waitFor(() => playback.hasActivePlayback);
  await assert.rejects(playback.playChunk("second", 1), /already active/);
  await playback.cancel();
  await assert.rejects(pending, SpeechCancelledError);
});
