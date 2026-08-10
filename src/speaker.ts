import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable } from "node:stream";
import { DEFAULT_PLAYBACK_SPEED, MAX_PLAYBACK_SPEED, MIN_PLAYBACK_SPEED } from "./controls.ts";
import { cleanMarkdownForSpeech } from "./clean.ts";
import {
  OpenAISpeechPlayback,
  SpeechCancelledError,
  SpeechError,
  splitSpeechText,
} from "./speech.ts";

/** Substring every speaker command line carries, used to reject reused pids. */
export const SPEAKER_MARKER = "cc-talk-speak";
export const SPEAKER_STATE_DIR_ENV = "CC_TALK_STATE_DIR";
export const PID_FILE_NAME = "speaker.pid";
export const STATE_FILE_NAME = "state";
export const SPEED_FILE_NAME = "speed";
export const LOG_FILE_NAME = "speaker.log";
export const SECRETS_FILE_NAME = ".secrets/env";

/** Mirrors the speech.ts teardown ladder (src/speech.ts:668-672). */
export const TERM_GRACE_MS = 250;
export const KILL_GRACE_MS = 1_000;
const LIVENESS_POLL_MS = 10;

/** Sent to the daemon pid alone: mpv must stay alive, merely frozen. */
export const PAUSE_SIGNAL: NodeJS.Signals = "SIGUSR1";
export const RESUME_SIGNAL: NodeJS.Signals = "SIGUSR2";

const USAGE = `Usage:
  cc-talk-speak [--file <path>]   speak text from <path> (deleted after reading) or stdin
  cc-talk-speak --stop            stop the current speaker
  cc-talk-speak --pause           freeze the current speaker at its position
  cc-talk-speak --unpause         continue a frozen speaker
  cc-talk-speak --help            show this message

Environment:
  OPENAI_API_KEY   required; falls back to ~/.secrets/env
  PI_TALK_SPEED    playback speed, ${MIN_PLAYBACK_SPEED.toFixed(2)}-${MAX_PLAYBACK_SPEED.toFixed(2)} (default ${DEFAULT_PLAYBACK_SPEED.toFixed(2)})

Files:
  <state dir>/${SPEED_FILE_NAME}   plain decimal speed, re-read before every chunk;
                   outranks PI_TALK_SPEED, delete it to fall back (\`talk speed reset\`)
`;

export type SpeakerErrorCode = "usage" | "configuration" | "input" | "unexpected";

/** Carries a message that is already safe to write to the speaker log. */
export class SpeakerError extends Error {
  readonly code: SpeakerErrorCode;
  readonly userMessage: string;

  constructor(code: SpeakerErrorCode, userMessage: string) {
    super(userMessage);
    this.name = "SpeakerError";
    this.code = code;
    this.userMessage = userMessage;
  }
}

export type SpeakerRecord = {
  pid: number;
  pgid: number;
  startedAt: number;
};

export type SpeakerPlaybackState = "playing" | "paused";

export type ProcessDescription = {
  pgid: number;
  command: string;
};

export type ProcessProbe = {
  isAlive(pid: number): boolean;
  describe(pid: number): ProcessDescription | undefined;
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /** Signals one process. Pause/resume use this so mpv stays alive, merely frozen. */
  signalProcess(pid: number, signal: NodeJS.Signals): void;
};

export type SpeakerFileSystem = {
  ensureDirectory(path: string): void;
  readText(path: string): string | undefined;
  writeText(path: string, contents: string): void;
  appendText(path: string, contents: string): void;
  remove(path: string): void;
};

export type SpeakerPlayback = {
  playChunk(text: string, playbackSpeed: number): Promise<void>;
  cancel(): Promise<void>;
  /** Exact-position freeze; absent on players that cannot pause. */
  pause?(): Promise<void>;
  resume?(): Promise<void>;
};

export type SpeakerEnvironment = {
  env: NodeJS.ProcessEnv;
  files: SpeakerFileSystem;
  probe: ProcessProbe;
  signals: EventEmitter;
  stdin: Readable;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  entryScript: string;
  pid: number;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  spawnDaemon(argv: string[]): ChildProcess;
  createPlayback(apiKey: string): SpeakerPlayback;
};

export function defaultFileSystem(): SpeakerFileSystem {
  return {
    ensureDirectory(path) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
    },
    readText(path) {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    writeText(path, contents) {
      writeFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
    },
    appendText(path, contents) {
      appendFileSync(path, contents, { encoding: "utf8", mode: 0o600 });
    },
    remove(path) {
      rmSync(path, { force: true });
    },
  };
}

export function defaultProcessProbe(): ProcessProbe {
  return {
    isAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    describe(pid) {
      if (!Number.isInteger(pid) || pid <= 1) return undefined;
      let output: string;
      try {
        output = execFileSync("ps", ["-o", "pgid=,command=", "-p", String(pid)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      } catch {
        return undefined;
      }
      const match = /^\s*(\d+)\s+(.*)$/.exec(output.trim());
      if (!match) return undefined;
      return { pgid: Number(match[1]), command: match[2] };
    },
    signalGroup(pgid, signal) {
      // Guard against signalling init or every process the user owns.
      if (!Number.isInteger(pgid) || pgid <= 1) return;
      try {
        process.kill(-pgid, signal);
      } catch {
        // The group is already gone; supersession is still satisfied.
      }
    },
    signalProcess(pid, signal) {
      if (!Number.isInteger(pid) || pid <= 1) return;
      try {
        process.kill(pid, signal);
      } catch {
        // The speaker is already gone; pause and unpause are idempotent.
      }
    },
  };
}

function defaultSpawnDaemon(argv: string[]): ChildProcess {
  const [script, ...rest] = argv;
  return spawn(process.execPath, [script, ...rest], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
  });
}

function defaultEnvironment(overrides: Partial<SpeakerEnvironment>): SpeakerEnvironment {
  return {
    env: process.env,
    files: defaultFileSystem(),
    probe: defaultProcessProbe(),
    signals: process as unknown as EventEmitter,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    entryScript: process.argv[1] ?? "",
    pid: process.pid,
    now: () => Date.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    spawnDaemon: defaultSpawnDaemon,
    createPlayback: (apiKey) => new OpenAISpeechPlayback({ apiKey }),
    ...overrides,
  };
}

export function speakerStateDir(env: NodeJS.ProcessEnv): string {
  const override = env[SPEAKER_STATE_DIR_ENV]?.trim();
  if (override) return override;
  return join(env.HOME?.trim() || homedir(), ".claude", "cc-talk");
}

export function speakerPidPath(stateDir: string): string {
  return join(stateDir, PID_FILE_NAME);
}

export function speakerStatePath(stateDir: string): string {
  return join(stateDir, STATE_FILE_NAME);
}

export function speakerLogPath(stateDir: string): string {
  return join(stateDir, LOG_FILE_NAME);
}

export function speakerSpeedPath(stateDir: string): string {
  return join(stateDir, SPEED_FILE_NAME);
}

export function secretsPath(env: NodeJS.ProcessEnv): string {
  return join(env.HOME?.trim() || homedir(), SECRETS_FILE_NAME);
}

/**
 * Reads `KEY=value` and `export KEY=value` lines. Values are never logged or
 * echoed anywhere; only the requested key is ever read back out.
 */
export function parseSecretsEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;

    const value = match[2].trim();
    const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
    values[match[1]] = quoted ? quoted[2] : value;
  }

  return values;
}

export function resolveApiKey(env: NodeJS.ProcessEnv, readSecrets: () => string | undefined): string {
  const direct = env.OPENAI_API_KEY?.trim();
  if (direct) return direct;

  const contents = readSecrets();
  const fallback = contents ? parseSecretsEnv(contents).OPENAI_API_KEY?.trim() : undefined;
  if (fallback) return fallback;

  throw new SpeakerError(
    "configuration",
    "OPENAI_API_KEY is not set and ~/.secrets/env does not define it.",
  );
}

/** A speed only counts when it is a finite number inside the supported range. */
function parsePlaybackSpeed(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim();
  if (!trimmed) return undefined;

  const configured = Number(trimmed);
  return Number.isFinite(configured) && configured >= MIN_PLAYBACK_SPEED && configured <= MAX_PLAYBACK_SPEED
    ? configured
    : undefined;
}

export function resolvePlaybackSpeed(env: NodeJS.ProcessEnv): number {
  return parsePlaybackSpeed(env.PI_TALK_SPEED) ?? DEFAULT_PLAYBACK_SPEED;
}

/**
 * The speed knob `talk speed` turns. There is no IPC into a running daemon, so
 * the file is the channel: the daemon re-reads it before every chunk and the
 * newest value lands on the next one — a mid-utterance change costs one chunk
 * of latency, never a restart.
 *
 * The file outranks `PI_TALK_SPEED`, which only seeds the daemon at spawn.
 * Deleting the file (`talk speed reset`) falls back to that seed. Unreadable or
 * out-of-range content is ignored so a half-written file cannot lurch playback:
 * the last good speed stands.
 */
export function createSpeedReader(
  stateDir: string,
  files: SpeakerFileSystem,
  spawnSpeed: number,
): () => number {
  let current = spawnSpeed;

  return () => {
    const contents = files.readText(speakerSpeedPath(stateDir));
    if (contents === undefined) {
      current = spawnSpeed;
      return current;
    }

    const parsed = parsePlaybackSpeed(contents);
    if (parsed !== undefined) current = parsed;
    return current;
  };
}

export function readSpeakerRecord(stateDir: string, files: SpeakerFileSystem): SpeakerRecord | undefined {
  const contents = files.readText(speakerPidPath(stateDir));
  if (!contents) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }

  const record = parsed as Partial<SpeakerRecord> | null;
  if (!record || !Number.isInteger(record.pid) || !Number.isInteger(record.pgid)) return undefined;
  return {
    pid: record.pid as number,
    pgid: record.pgid as number,
    startedAt: Number.isFinite(record.startedAt) ? (record.startedAt as number) : 0,
  };
}

export function writeSpeakerRecord(stateDir: string, files: SpeakerFileSystem, record: SpeakerRecord): void {
  files.ensureDirectory(stateDir);
  files.writeText(speakerPidPath(stateDir), `${JSON.stringify(record)}\n`);
}

/**
 * Deletes the pidfile only while it still names `pid`, so a newer speaker
 * survives. The state file rides along: it describes whatever the pidfile
 * points at, so the two are always created and destroyed together.
 */
export function clearSpeakerRecord(stateDir: string, files: SpeakerFileSystem, pid: number): void {
  const current = readSpeakerRecord(stateDir, files);
  if (current && current.pid !== pid) return;
  files.remove(speakerPidPath(stateDir));
  files.remove(speakerStatePath(stateDir));
}

/**
 * Whether the speaker is mid-sentence or frozen. Readers outside this process
 * (the `talk cycle` keybinding) need it to pick pause vs unpause, and a signal
 * carries no payload to ask with.
 */
export function readSpeakerState(stateDir: string, files: SpeakerFileSystem): SpeakerPlaybackState | undefined {
  const contents = files.readText(speakerStatePath(stateDir))?.trim();
  return contents === "playing" || contents === "paused" ? contents : undefined;
}

export function writeSpeakerState(stateDir: string, files: SpeakerFileSystem, state: SpeakerPlaybackState): void {
  files.ensureDirectory(stateDir);
  files.writeText(speakerStatePath(stateDir), `${state}\n`);
}

/**
 * Records a pause/resume transition, but only while the pidfile still names
 * `pid`. A daemon that has already lost the speaker to a newcomer must not
 * describe the newcomer's playback.
 */
export function updateSpeakerState(
  stateDir: string,
  files: SpeakerFileSystem,
  pid: number,
  state: SpeakerPlaybackState,
): void {
  if (readSpeakerRecord(stateDir, files)?.pid !== pid) return;
  writeSpeakerState(stateDir, files, state);
}

/**
 * A pid alone cannot be trusted: the kernel reuses them. A record is live only
 * when the process exists, still leads the recorded group, and still looks like
 * a speaker.
 */
export function isSpeakerRecordLive(record: SpeakerRecord, probe: ProcessProbe): boolean {
  if (!probe.isAlive(record.pid)) return false;

  const description = probe.describe(record.pid);
  if (!description) return false;
  return description.pgid === record.pgid && description.command.includes(SPEAKER_MARKER);
}

async function waitForExit(
  pid: number,
  probe: ProcessProbe,
  graceMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(graceMs / LIVENESS_POLL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!probe.isAlive(pid)) return true;
    await sleep(LIVENESS_POLL_MS);
  }
  return !probe.isAlive(pid);
}

/**
 * SIGTERM to the whole group (daemon plus the mpv it spawned), then SIGKILL,
 * mirroring the in-process ladder at src/speech.ts:668-672.
 */
export async function terminateSpeakerGroup(
  record: SpeakerRecord,
  probe: ProcessProbe,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<boolean> {
  probe.signalGroup(record.pgid, "SIGTERM");
  if (await waitForExit(record.pid, probe, TERM_GRACE_MS, sleep)) return true;

  probe.signalGroup(record.pgid, "SIGKILL");
  return waitForExit(record.pid, probe, KILL_GRACE_MS, sleep);
}

/** Newest wins: stop whoever holds the state dir, then record ourselves. */
export async function claimSpeaker(environment: SpeakerEnvironment, stateDir: string): Promise<SpeakerRecord> {
  const previous = readSpeakerRecord(stateDir, environment.files);
  if (previous && previous.pid !== environment.pid && isSpeakerRecordLive(previous, environment.probe)) {
    await terminateSpeakerGroup(previous, environment.probe, environment.sleep);
  }

  const pgid = environment.probe.describe(environment.pid)?.pgid ?? environment.pid;
  const record: SpeakerRecord = { pid: environment.pid, pgid, startedAt: environment.now() };
  writeSpeakerRecord(stateDir, environment.files, record);
  // A fresh claim is always mid-sentence; any pause the previous speaker
  // recorded died with it.
  writeSpeakerState(stateDir, environment.files, "playing");
  return record;
}

/** Always succeeds, including when nothing is playing. */
export async function stopSpeaker(environment: SpeakerEnvironment, stateDir: string): Promise<void> {
  const record = readSpeakerRecord(stateDir, environment.files);
  if (!record) return;

  if (isSpeakerRecordLive(record, environment.probe)) {
    await terminateSpeakerGroup(record, environment.probe, environment.sleep);
  }
  clearSpeakerRecord(stateDir, environment.files, record.pid);
}

/**
 * Signals the recorded daemon — the pid only, never the group, so the player it
 * spawned survives. Returns whether a live speaker was there to receive it;
 * a missing, stale, or reused pidfile is a silent no-op.
 */
export function signalSpeaker(
  environment: SpeakerEnvironment,
  stateDir: string,
  signal: NodeJS.Signals,
): boolean {
  const record = readSpeakerRecord(stateDir, environment.files);
  if (!record || !isSpeakerRecordLive(record, environment.probe)) return false;

  environment.probe.signalProcess(record.pid, signal);
  return true;
}

/** Never returns provider bodies, spoken text, paths, or key material. */
export function sanitizeFailure(error: unknown): string {
  if (error instanceof SpeechError) return `${error.code}: ${error.userMessage}`;
  if (error instanceof SpeakerError) return `${error.code}: ${error.userMessage}`;
  return "unexpected: cc-talk-speak failed";
}

export function logSpeakerFailure(environment: SpeakerEnvironment, stateDir: string, error: unknown): void {
  const line = `${new Date(environment.now()).toISOString()} ${sanitizeFailure(error)}\n`;
  try {
    environment.files.ensureDirectory(stateDir);
    environment.files.appendText(speakerLogPath(stateDir), line);
  } catch {
    // A speaker that cannot log still must not crash the caller's shell.
  }
}

/**
 * `resolveSpeed` is asked once per chunk rather than once per utterance, which
 * is what lets `talk speed` reach a daemon that is already talking.
 */
export async function speakText(
  text: string,
  playback: SpeakerPlayback,
  resolveSpeed: () => number,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  // cleanMarkdownForSpeech already applies stripDelimitedMath; do not repeat it.
  const chunks = splitSpeechText(cleanMarkdownForSpeech(text));
  for (const chunk of chunks) {
    if (isCancelled()) return;
    await playback.playChunk(chunk, resolveSpeed());
  }
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function launchDaemon(environment: SpeakerEnvironment, text: string): Promise<number> {
  if (!text.trim()) return 0;
  if (!environment.entryScript) {
    throw new SpeakerError("unexpected", "The speaker could not locate its own executable.");
  }

  const child = environment.spawnDaemon([environment.entryScript, "--daemon"]);
  if (!child.stdin) throw new SpeakerError("unexpected", "The speaker daemon rejected its input pipe.");

  const flushed = once(child.stdin, "finish");
  child.stdin.end(text);
  child.unref();
  await flushed;
  return 0;
}

async function runDaemon(environment: SpeakerEnvironment, stateDir: string): Promise<number> {
  const text = await readAll(environment.stdin);
  if (!text.trim()) return 0;

  await claimSpeaker(environment, stateDir);

  let cancelled = false;
  let playback: SpeakerPlayback | undefined;
  const onTerminate = () => {
    cancelled = true;
    void playback?.cancel().catch(() => undefined);
  };
  // Pause and unpause are position-preserving, so they never set `cancelled`:
  // the daemon stays alive holding the pidfile and a frozen player.
  const onPause = () => {
    updateSpeakerState(stateDir, environment.files, environment.pid, "paused");
    void playback?.pause?.().catch(() => undefined);
  };
  const onResume = () => {
    updateSpeakerState(stateDir, environment.files, environment.pid, "playing");
    void playback?.resume?.().catch(() => undefined);
  };
  environment.signals.once("SIGTERM", onTerminate);
  environment.signals.on(PAUSE_SIGNAL, onPause);
  environment.signals.on(RESUME_SIGNAL, onResume);

  try {
    const apiKey = resolveApiKey(environment.env, () => environment.files.readText(secretsPath(environment.env)));
    playback = environment.createPlayback(apiKey);
    if (cancelled) return 0;
    const resolveSpeed = createSpeedReader(
      stateDir,
      environment.files,
      resolvePlaybackSpeed(environment.env),
    );
    await speakText(text, playback, resolveSpeed, () => cancelled);
    return 0;
  } catch (error) {
    if (cancelled || error instanceof SpeechCancelledError) return 0;
    logSpeakerFailure(environment, stateDir, error);
    return 1;
  } finally {
    environment.signals.removeListener("SIGTERM", onTerminate);
    environment.signals.removeListener(PAUSE_SIGNAL, onPause);
    environment.signals.removeListener(RESUME_SIGNAL, onResume);
    clearSpeakerRecord(stateDir, environment.files, environment.pid);
  }
}

export async function runSpeakerCli(
  argv: string[],
  overrides: Partial<SpeakerEnvironment> = {},
): Promise<number> {
  const environment = defaultEnvironment(overrides);
  const stateDir = speakerStateDir(environment.env);

  try {
    if (argv.includes("--help") || argv.includes("-h")) {
      environment.stdout.write(USAGE);
      return 0;
    }

    if (argv.includes("--stop")) {
      await stopSpeaker(environment, stateDir);
      return 0;
    }

    if (argv.includes("--pause")) {
      signalSpeaker(environment, stateDir, PAUSE_SIGNAL);
      return 0;
    }

    if (argv.includes("--unpause")) {
      signalSpeaker(environment, stateDir, RESUME_SIGNAL);
      return 0;
    }

    if (argv.includes("--daemon")) return await runDaemon(environment, stateDir);

    const fileIndex = argv.indexOf("--file");
    if (fileIndex >= 0) {
      const path = argv[fileIndex + 1];
      if (!path) throw new SpeakerError("usage", "--file requires a path.");

      const text = environment.files.readText(path);
      environment.files.remove(path);
      if (text === undefined) throw new SpeakerError("input", "The speech input file could not be read.");
      return await launchDaemon(environment, text);
    }

    const unknown = argv.find((argument) => argument.startsWith("-"));
    if (unknown) throw new SpeakerError("usage", "Unrecognized option.");

    return await launchDaemon(environment, await readAll(environment.stdin));
  } catch (error) {
    const message = sanitizeFailure(error);
    environment.stderr.write(`cc-talk-speak: ${message}\n`);
    if (error instanceof SpeakerError && error.code === "usage") {
      environment.stderr.write(USAGE);
      return 2;
    }
    logSpeakerFailure(environment, stateDir, error);
    return 1;
  }
}
