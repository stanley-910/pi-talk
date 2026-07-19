import { once } from "node:events";
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import type { EventEmitter } from "node:events";
import type { Duplex, Readable, Writable } from "node:stream";

export const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";
export const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts-2025-12-15";
export const OPENAI_SPEECH_VOICE = "marin";
export const MAX_SPEECH_CHUNK_BYTES = 1_800;

const DEFAULT_TIMEOUTS: SpeechTimeouts = {
  headerMs: 15_000,
  bodyIdleMs: 10_000,
  controlMs: 1_000,
  totalMs: 120_000,
  termGraceMs: 250,
  killGraceMs: 1_000,
};

export interface PlayerProcess extends EventEmitter {
  stdin: Writable;
  stderr: Readable;
  control: Duplex;
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

type SpawnPlayer = (command: string, args: string[]) => PlayerProcess;

function spawnDefaultPlayer(command: string, args: string[]): PlayerProcess {
  const player = spawn(command, args, { stdio: ["pipe", "ignore", "pipe", "pipe"] });
  const control = player.stdio[3];
  if (!player.stdin || !player.stderr || !control) throw new Error("mpv stdio unavailable");
  return Object.assign(player, { control: control as Duplex }) as PlayerProcess;
}

type SpeechTimeouts = {
  headerMs: number;
  bodyIdleMs: number;
  controlMs: number;
  totalMs: number;
  termGraceMs: number;
  killGraceMs: number;
};

type OpenAISpeechPlaybackOptions = {
  apiKey: string;
  fetcher?: typeof fetch;
  spawnPlayer?: SpawnPlayer;
  playerCommand?: string;
  timeouts?: Partial<SpeechTimeouts>;
};

export type SpeechErrorCode =
  | "authentication"
  | "request_rejected"
  | "rate_limit"
  | "provider"
  | "network"
  | "timeout"
  | "player_unavailable"
  | "playback"
  | "cleanup";

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  readonly userMessage: string;
  readonly status?: number;
  readonly requestId?: string;

  constructor(
    code: SpeechErrorCode,
    userMessage: string,
    message: string,
    details: { status?: number; requestId?: string } = {},
  ) {
    super(message);
    this.name = "SpeechError";
    this.code = code;
    this.userMessage = userMessage;
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export class SpeechCancelledError extends Error {
  constructor() {
    super("Speech playback was superseded");
    this.name = "SpeechCancelledError";
  }
}

type Deadline = "headers" | "body" | "total";

type PlayerOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

type ActivePlayback = {
  controller: AbortController;
  cancelled: boolean;
  deadline?: Deadline;
  responseBody?: ReadableStream<Uint8Array>;
  reader?: ReadableStreamDefaultReader<Uint8Array>;
  player?: PlayerProcess;
  playerControl?: MpvIpcClient;
  playerClosed?: Promise<PlayerOutcome>;
  playerOutcome?: PlayerOutcome;
  cleanupPromise?: Promise<void>;
  totalTimer?: NodeJS.Timeout;
  totalDeadline?: Promise<never>;
  interruption: Promise<never>;
  interrupt(error: Error): void;
  ioFailure?: Promise<never>;
  playerFailure?: Promise<never>;
  playerSpawnFailed?: boolean;
  stderr: string;
};

function utf8PrefixIndex(text: string, maximumBytes: number): number {
  let bytes = 0;
  let index = 0;

  for (const scalar of text) {
    const scalarBytes = Buffer.byteLength(scalar, "utf8");
    if (bytes + scalarBytes > maximumBytes) break;
    bytes += scalarBytes;
    index += scalar.length;
  }

  return index;
}

function semanticSplitIndex(prefix: string): number {
  const paragraph = prefix.lastIndexOf("\n\n");
  if (paragraph > 0) return paragraph;

  let sentence = 0;
  for (const match of prefix.matchAll(/[.!?](?:["')\]}]+)?(?=\s)/gu)) {
    sentence = (match.index ?? 0) + match[0].length;
  }
  if (sentence > 0) return sentence;

  let whitespace = 0;
  for (const match of prefix.matchAll(/\s+/gu)) whitespace = match.index ?? 0;
  return whitespace > 0 ? whitespace : prefix.length;
}

export function stripDelimitedMath(text: string): string {
  return text
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$([^$\n]+)\$/g, (match, body: string, offset: number, source: string) => {
      const nextCharacter = source[offset + match.length] ?? "";
      const opensOrClosesWithWhitespace = /^\s|\s$/u.test(body);
      const closingDelimiterIsFollowedByDigit = /^\d/u.test(nextCharacter);
      return opensOrClosesWithWhitespace || closingDelimiterIsFollowedByDigit ? match : " ";
    })
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ");
}

export function splitSpeechText(text: string, maximumBytes = MAX_SPEECH_CHUNK_BYTES): string[] {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 4) {
    throw new RangeError("maximumBytes must be an integer of at least 4");
  }

  const chunks: string[] = [];
  let remaining = text.trim();

  while (remaining) {
    if (Buffer.byteLength(remaining, "utf8") <= maximumBytes) {
      chunks.push(remaining);
      break;
    }

    const prefixEnd = utf8PrefixIndex(remaining, maximumBytes);
    if (prefixEnd === 0) throw new RangeError("maximumBytes cannot fit the next Unicode scalar");

    const prefix = remaining.slice(0, prefixEnd);
    const splitAt = semanticSplitIndex(prefix);
    const chunk = remaining.slice(0, splitAt).trim();
    if (!chunk) throw new Error("speech chunking produced an empty chunk");

    chunks.push(chunk);
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

function responseError(response: Response): SpeechError {
  const status = response.status;
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const details = { status, requestId };

  if (status === 401 || status === 403) {
    return new SpeechError(
      "authentication",
      "Speech unavailable: check the OpenAI API key and project permissions.",
      `OpenAI speech authentication failed (${status})${requestId ? ` [${requestId}]` : ""}`,
      details,
    );
  }
  if (status === 400) {
    return new SpeechError(
      "request_rejected",
      "Speech request rejected.",
      `OpenAI speech rejected the request (${status})${requestId ? ` [${requestId}]` : ""}`,
      details,
    );
  }
  if (status === 408 || status === 429) {
    return new SpeechError(
      "rate_limit",
      "Speech temporarily unavailable (rate limited or timed out).",
      `OpenAI speech was rate limited or timed out (${status})${requestId ? ` [${requestId}]` : ""}`,
      details,
    );
  }

  return new SpeechError(
    "provider",
    "Speech temporarily unavailable.",
    `OpenAI speech failed (${status})${requestId ? ` [${requestId}]` : ""}`,
    details,
  );
}

function playerPromise(player: PlayerProcess, active: ActivePlayback): Promise<PlayerOutcome> {
  return new Promise((resolve) => {
    player.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
      const outcome = { code, signal };
      active.playerOutcome = outcome;
      resolve(outcome);
    });
  });
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type IpcRequest = {
  resolve(): void;
  reject(error: Error): void;
};

class MpvIpcClient {
  private readonly stream: Duplex;
  private readonly pending = new Map<number, IpcRequest>();
  private buffer = "";
  private sequence = 0;
  private failure?: Error;

  constructor(stream: Duplex) {
    this.stream = stream;
    stream.on("data", (chunk) => this.handleData(String(chunk)));
    stream.on("error", () => this.fail(new Error("mpv IPC stream failed")));
    stream.on("close", () => this.fail(new Error("mpv IPC stream closed")));
  }

  setPaused(paused: boolean): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);

    const requestId = ++this.sequence;
    const response = new Promise<void>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
    });

    try {
      this.stream.write(
        `${JSON.stringify({ command: ["set_property", "pause", paused], request_id: requestId })}\n`,
      );
    } catch {
      this.fail(new Error("mpv IPC write failed"));
    }

    return response;
  }

  destroy(): void {
    this.fail(new Error("mpv IPC client closed"));
    this.stream.destroy();
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");

    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;

      let message: { request_id?: unknown; error?: unknown };
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof message.request_id !== "number") continue;
      const request = this.pending.get(message.request_id);
      if (!request) continue;
      this.pending.delete(message.request_id);
      if (message.error === "success") request.resolve();
      else request.reject(new Error("mpv IPC pause command failed"));
    }
  }

  private fail(error: Error): void {
    if (!this.failure) this.failure = error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }
}

export class OpenAISpeechPlayback {
  private readonly apiKey: string;
  private readonly fetcher: typeof fetch;
  private readonly spawnPlayer: SpawnPlayer;
  private readonly playerCommand: string;
  private readonly timeouts: SpeechTimeouts;
  private active?: ActivePlayback;
  private cancellation: Promise<void> = Promise.resolve();
  private cleanupFailure?: unknown;
  private paused = false;

  constructor(options: OpenAISpeechPlaybackOptions) {
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
    this.spawnPlayer = options.spawnPlayer ?? spawnDefaultPlayer;
    this.playerCommand = options.playerCommand ?? "mpv";
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
  }

  get hasActivePlayback(): boolean {
    return this.active !== undefined;
  }

  pause(): Promise<void> {
    return this.setPaused(true);
  }

  resume(): Promise<void> {
    return this.setPaused(false);
  }

  async cancel(): Promise<void> {
    this.paused = false;
    const active = this.active;
    if (!active) return this.cancellation;

    active.cancelled = true;
    active.interrupt(new SpeechCancelledError());
    this.active = undefined;
    const previous = this.cancellation;
    const cancellation = (async () => {
      await previous.catch(() => undefined);
      try {
        await this.cleanup(active);
      } catch (error) {
        this.cleanupFailure = error;
        throw error;
      }
    })();
    this.cancellation = cancellation;
    return cancellation;
  }

  async playChunk(text: string, playbackSpeed: number): Promise<void> {
    if (this.cleanupFailure) throw this.cleanupFailure;
    await this.cancellation;
    if (this.active) throw new Error("Speech playback is already active");

    let interrupt = (_error: Error) => undefined;
    const interruption = new Promise<never>((_resolve, reject) => {
      interrupt = (error) => reject(error);
    });
    void interruption.catch(() => undefined);

    const active: ActivePlayback = {
      controller: new AbortController(),
      cancelled: false,
      interruption,
      interrupt,
      stderr: "",
    };
    this.active = active;
    this.startTotalDeadline(active);

    try {
      const response = await this.withStageDeadline(
        active,
        this.fetcher(OPENAI_SPEECH_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            Accept: "audio/wav, application/octet-stream",
          },
          body: JSON.stringify({
            model: OPENAI_SPEECH_MODEL,
            voice: OPENAI_SPEECH_VOICE,
            input: text,
            response_format: "wav",
            stream_format: "audio",
            speed: 1,
          }),
          signal: active.controller.signal,
        }),
        this.timeouts.headerMs,
        "headers",
      );

      this.assertCurrent(active);
      active.responseBody = response.body ?? undefined;
      if (!response.ok) throw responseError(response);
      if (!response.body) {
        throw new SpeechError(
          "provider",
          "Speech temporarily unavailable.",
          "OpenAI speech returned no audio body",
        );
      }

      let player: PlayerProcess;
      try {
        player = this.spawnPlayer(this.playerCommand, [
          "--no-config",
          "--no-video",
          "--no-terminal",
          "--msg-level=all=error",
          "--input-ipc-client=fd://3",
          "--audio-pitch-correction=yes",
          `--speed=${playbackSpeed}`,
          "--demuxer-lavf-format=wav",
          `--pause=${this.paused ? "yes" : "no"}`,
          "-",
        ]);
      } catch {
        throw new SpeechError(
          "player_unavailable",
          "Speech unavailable: install mpv or configure PI_SPEAK_PLAYER.",
          "Unable to start the speech player",
        );
      }

      active.player = player;
      active.playerControl = new MpvIpcClient(player.control);
      active.playerClosed = playerPromise(player, active);
      active.playerFailure = new Promise<never>((_resolve, reject) => {
        player.on("error", () => {
          if (player.pid === undefined) {
            active.playerSpawnFailed = true;
            reject(
              new SpeechError(
                "player_unavailable",
                "Speech unavailable: install mpv or configure PI_SPEAK_PLAYER.",
                "Speech player failed to start",
              ),
            );
            return;
          }
          reject(new SpeechError("playback", "Speech playback failed.", "Speech player process failed"));
        });
      });
      void active.playerFailure.catch(() => undefined);
      active.ioFailure = new Promise<never>((_resolve, reject) => {
        player.stdin.on("error", () => {
          reject(new SpeechError("playback", "Speech playback failed.", "Speech player stdin failed"));
        });
      });
      void active.ioFailure.catch(() => undefined);
      player.stderr.on("data", (chunk) => {
        if (active.stderr.length >= 2_048) return;
        active.stderr = (active.stderr + String(chunk)).slice(0, 2_048);
      });
      active.reader = response.body.getReader();
      while (true) {
        this.assertCurrent(active);
        const result = await this.withStageDeadline(
          active,
          active.reader.read(),
          this.timeouts.bodyIdleMs,
          "body",
        );
        if (result.done) break;
        if (!result.value || result.value.byteLength === 0) continue;

        this.assertCurrent(active);
        if (active.playerOutcome) throw this.playerFailure(active.playerOutcome);
        if (!player.stdin.write(result.value)) {
          await this.withTotalDeadline(
            active,
            Promise.race([
              once(player.stdin, "drain").then(() => undefined),
              active.playerClosed.then((outcome) => {
                throw this.playerFailure(outcome);
              }),
            ]),
          );
        }
      }

      this.assertCurrent(active);
      player.stdin.end();
      const outcome = await this.withTotalDeadline(active, active.playerClosed);
      this.assertCurrent(active);
      if (outcome.code !== 0) throw this.playerFailure(outcome);
    } catch (error) {
      const wasCancelled = active.cancelled;
      let cleanupError: unknown;
      try {
        await this.cleanup(active);
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
        this.cleanupFailure = cleanupFailure;
      }

      if (wasCancelled || active.cancelled || error instanceof SpeechCancelledError) {
        if (cleanupError) throw cleanupError;
        throw new SpeechCancelledError();
      }
      if (cleanupError) throw cleanupError;
      if (active.deadline) {
        throw new SpeechError(
          "timeout",
          "Speech temporarily unavailable (timeout).",
          `Speech ${active.deadline} deadline expired`,
        );
      }
      if (error instanceof SpeechError) throw error;
      throw new SpeechError("network", "Speech temporarily unavailable (network error).", "Speech network failed");
    } finally {
      this.clearDeadlines(active);
      if (this.active === active) this.active = undefined;
    }
  }

  private async setPaused(paused: boolean): Promise<void> {
    const active = this.active;
    const control = active?.playerControl;
    if (!control) {
      this.paused = paused;
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        control.setPaused(paused),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("mpv IPC command timed out")), this.timeouts.controlMs);
        }),
      ]);
      this.paused = paused;
    } catch {
      if (active.cancelled || this.active !== active) throw new SpeechCancelledError();
      const failure = new SpeechError(
        "playback",
        "Speech playback control failed.",
        "Speech player pause control failed",
      );
      active.interrupt(failure);
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private assertCurrent(active: ActivePlayback): void {
    if (active.cancelled || this.active !== active) throw new SpeechCancelledError();
  }

  private playerFailure(outcome: PlayerOutcome): SpeechError {
    return new SpeechError(
      "playback",
      "Speech playback failed.",
      `Speech player exited with ${outcome.code ?? outcome.signal ?? "unknown status"}`,
    );
  }

  private startTotalDeadline(active: ActivePlayback): void {
    active.totalDeadline = new Promise<never>((_resolve, reject) => {
      active.totalTimer = setTimeout(() => {
        active.deadline = "total";
        active.controller.abort();
        reject(new Error("speech total deadline expired"));
      }, this.timeouts.totalMs);
    });
  }

  private async withTotalDeadline<T>(active: ActivePlayback, operation: Promise<T>): Promise<T> {
    const competitors: Array<Promise<T> | Promise<never>> = [
      operation,
      active.totalDeadline as Promise<never>,
      active.interruption,
    ];
    if (active.ioFailure) competitors.push(active.ioFailure);
    if (active.playerFailure) competitors.push(active.playerFailure);
    return Promise.race(competitors);
  }

  private async withStageDeadline<T>(
    active: ActivePlayback,
    operation: Promise<T>,
    timeoutMs: number,
    deadline: Exclude<Deadline, "total">,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const stageDeadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        active.deadline = deadline;
        active.controller.abort();
        reject(new Error(`speech ${deadline} deadline expired`));
      }, timeoutMs);
    });

    try {
      return await this.withTotalDeadline(active, Promise.race([operation, stageDeadline]));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private clearDeadlines(active: ActivePlayback): void {
    if (active.totalTimer) clearTimeout(active.totalTimer);
  }

  private cleanup(active: ActivePlayback): Promise<void> {
    if (active.cleanupPromise) return active.cleanupPromise;

    active.cleanupPromise = (async () => {
      this.clearDeadlines(active);
      active.playerControl?.destroy();
      active.player?.stdin.destroy();
      active.controller.abort();

      try {
        const streamCancellation = active.reader?.cancel() ?? active.responseBody?.cancel();
        void streamCancellation?.catch(() => undefined);
      } catch {
        // Cancellation races with a pending read and is expected during teardown.
      }

      const player = active.player;
      if (!player || !active.playerClosed || active.playerOutcome || active.playerSpawnFailed) return;

      player.kill("SIGTERM");
      if (await settlesWithin(active.playerClosed, this.timeouts.termGraceMs)) return;

      player.kill("SIGKILL");
      if (await settlesWithin(active.playerClosed, this.timeouts.killGraceMs)) return;

      throw new SpeechError(
        "cleanup",
        "Speech playback could not be stopped safely.",
        "Speech player did not close after SIGKILL",
      );
    })();

    return active.cleanupPromise;
  }
}
