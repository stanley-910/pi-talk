import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  COARSE_SPEED_STEP,
  DEFAULT_PLAYBACK_SPEED,
  FINE_SPEED_STEP,
  MAX_PLAYBACK_SPEED,
  MIN_PLAYBACK_SPEED,
  clampPlaybackSpeed,
  primaryShortcutAction,
  registerPiTalkShortcuts,
  type SpeechMode,
} from "./controls.ts";
import {
  OPENAI_SPEECH_MODEL,
  OPENAI_SPEECH_VOICE,
  OpenAISpeechPlayback,
  SpeechCancelledError,
  SpeechError,
  splitSpeechText,
  stripDelimitedMath,
} from "./speech.ts";

const STATUS_ID = "pi-talk";
const AI_VOICE_DISCLOSURE =
  "AI voice: Pi Talk sends cleaned assistant text to OpenAI to generate speech. OpenAI may retain API content for up to 30 days for abuse monitoring unless your organization has approved data-retention controls. Audio is streamed to a local player and is not saved by Pi Talk.";

type UiLevel = "info" | "warning" | "error";

type SpeechState = {
  mode: SpeechMode;
  playbackSpeed: number;
  processing: boolean;
  queue: string[];
  generation: number;
  activeContext?: ExtensionContext;
  playback?: OpenAISpeechPlayback;
  disclosureShown: boolean;
  messageMarkdown: string;
  currentUtterances: string[];
  latestCompleteUtterances: string[];
  committedUtteranceCount: number;
  currentMessageStreaming: boolean;
  currentMessageComplete: boolean;
  seenQuestionCalls: Set<string>;
};

function configuredPlaybackSpeed(): number {
  const raw = process.env.PI_TALK_SPEED?.trim();
  if (!raw) return DEFAULT_PLAYBACK_SPEED;

  const configured = Number(raw);
  return Number.isFinite(configured) && configured >= MIN_PLAYBACK_SPEED && configured <= MAX_PLAYBACK_SPEED
    ? configured
    : DEFAULT_PLAYBACK_SPEED;
}

function formatPlaybackSpeed(speed: number): string {
  return `${speed.toFixed(2)}×`;
}

export default function piSpeakPrototype(pi: ExtensionAPI) {
  const state: SpeechState = {
    mode: "gagged",
    playbackSpeed: configuredPlaybackSpeed(),
    processing: false,
    queue: [],
    generation: 0,
    disclosureShown: false,
    messageMarkdown: "",
    currentUtterances: [],
    latestCompleteUtterances: [],
    committedUtteranceCount: 0,
    currentMessageStreaming: false,
    currentMessageComplete: false,
    seenQuestionCalls: new Set(),
  };

  function notify(ctx: ExtensionContext | undefined, message: string, level: UiLevel = "info") {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  }

  function notifySpeechError(error: unknown) {
    if (error instanceof SpeechCancelledError) return;
    const message = error instanceof SpeechError ? error.userMessage : "Speech playback failed.";
    notify(state.activeContext, message, "error");
  }

  function ensurePlayback(): OpenAISpeechPlayback | undefined {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return undefined;

    state.playback ??= new OpenAISpeechPlayback({
      apiKey,
      playerCommand: process.env.PI_SPEAK_PLAYER || "mpv",
    });
    return state.playback;
  }

  function showDisclosure(ctx: ExtensionContext) {
    if (state.disclosureShown) return;

    if (ctx.hasUI) ctx.ui.notify(AI_VOICE_DISCLOSURE, "info");
    else process.stderr.write(`[pi-talk] ${AI_VOICE_DISCLOSURE}\n`);
    state.disclosureShown = true;
  }

  function updateStatus() {
    const ctx = state.activeContext;
    if (!ctx?.hasUI) return;

    let label: string = state.mode;
    if (state.mode === "talking" && (state.processing || state.queue.length > 0)) {
      label = `talking (${state.queue.length} queued)`;
    }

    const provider = state.mode === "gagged" ? "" : "AI voice · OpenAI · ";
    ctx.ui.setStatus(STATUS_ID, `${provider}${label} · ${formatPlaybackSpeed(state.playbackSpeed)}`);
  }

  function applyPlaybackSpeed(ctx: ExtensionContext, speed: number, reset = false) {
    state.playbackSpeed = clampPlaybackSpeed(speed);
    updateStatus();
    const action = reset ? "reset" : "set";
    notify(ctx, `Playback speed ${action} to ${formatPlaybackSpeed(state.playbackSpeed)} for the next utterance`);
  }

  async function openPlaybackSpeedControl(ctx: ExtensionContext) {
    const selected = await ctx.ui.custom<number | undefined>((tui, theme, keybindings, done) => {
      let draft = state.playbackSpeed;

      const adjust = (delta: number) => {
        draft = clampPlaybackSpeed(draft + delta);
        tui.requestRender();
      };

      return {
        render(width: number) {
          const trackWidth = Math.max(5, Math.min(28, width - 16));
          const ratio = (draft - MIN_PLAYBACK_SPEED) / (MAX_PLAYBACK_SPEED - MIN_PLAYBACK_SPEED);
          const thumb = Math.round(ratio * (trackWidth - 1));
          const track =
            theme.fg("accent", "━".repeat(thumb)) +
            theme.fg("accent", "●") +
            theme.fg("dim", "─".repeat(trackWidth - thumb - 1));

          return [
            theme.fg("accent", theme.bold("Pi Talk playback speed")),
            "",
            `${MIN_PLAYBACK_SPEED.toFixed(2)}× ${track} ${MAX_PLAYBACK_SPEED.toFixed(2)}×`,
            theme.fg("accent", theme.bold(formatPlaybackSpeed(draft))),
            theme.fg("muted", `Playback: ${state.mode}`),
            "",
            theme.fg("muted", "j faster · k slower (0.10×) · Shift+j/k 0.05×"),
            theme.fg("muted", "←/→ also adjust · Space pause/unpause · r reset"),
            theme.fg("muted", "Enter apply · Esc/Ctrl+C cancel · applies to next utterance"),
          ].map((line) => truncateToWidth(line, width));
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.shift("j"))) adjust(FINE_SPEED_STEP);
          else if (matchesKey(data, Key.shift("k"))) adjust(-FINE_SPEED_STEP);
          else if (matchesKey(data, "j")) adjust(COARSE_SPEED_STEP);
          else if (matchesKey(data, "k")) adjust(-COARSE_SPEED_STEP);
          else if (matchesKey(data, Key.left) || data === "[") adjust(-COARSE_SPEED_STEP);
          else if (matchesKey(data, Key.right) || data === "]") adjust(COARSE_SPEED_STEP);
          else if (matchesKey(data, Key.space)) {
            if (state.mode === "talking") void setSpeechPaused(ctx, true).finally(() => tui.requestRender());
            else if (state.mode === "paused") void setSpeechPaused(ctx, false).finally(() => tui.requestRender());
            else notify(ctx, "Pi Talk is gagged; use /talk first", "warning");
          } else if (matchesKey(data, Key.home)) {
            draft = MIN_PLAYBACK_SPEED;
            tui.requestRender();
          } else if (matchesKey(data, Key.end)) {
            draft = MAX_PLAYBACK_SPEED;
            tui.requestRender();
          } else if (data.toLowerCase() === "r") {
            draft = DEFAULT_PLAYBACK_SPEED;
            tui.requestRender();
          } else if (matchesKey(data, Key.enter) || keybindings.matches(data, "tui.select.confirm")) done(draft);
          else if (matchesKey(data, Key.escape) || keybindings.matches(data, "tui.select.cancel")) done(undefined);
        },
      };
    });

    if (selected === undefined) {
      notify(ctx, `Playback speed unchanged at ${formatPlaybackSpeed(state.playbackSpeed)}`);
      return;
    }

    applyPlaybackSpeed(ctx, selected);
  }

  function resetAccumulator() {
    state.messageMarkdown = "";
  }

  function stripFencedCode(markdown: string): string {
    let fence: { marker: "`" | "~"; length: number } | undefined;
    const prose: string[] = [];

    for (const line of markdown.split(/\r?\n/)) {
      const indent = line.match(/^ */)?.[0].length ?? 0;
      const candidate = indent <= 3 ? line.slice(indent) : "";
      const run = candidate.match(/^(`+|~+)/)?.[0];

      if (!fence) {
        if (run && run.length >= 3) {
          fence = { marker: run[0] as "`" | "~", length: run.length };
        } else {
          prose.push(line);
        }
        continue;
      }

      if (
        run &&
        run[0] === fence.marker &&
        run.length >= fence.length &&
        candidate.slice(run.length).trim() === ""
      ) {
        fence = undefined;
      }
    }

    return prose.join("\n");
  }

  function cleanForSpeech(text: string): string {
    return stripDelimitedMath(text)
      .replace(/\\begin\{([^}]+)}[\s\S]*?\\end\{\1}/g, " ")
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/(`+)([^`\n]+)\1/g, "$2")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^\s{0,3}(?:#{1,6}|[-*+] |\d+[.)] )/gm, "")
      .replace(/[>*_~]/g, "")
      .replace(/(^|\s)[,;:]+(?=\s|$)/g, "$1")
      .replace(/\b(?:and|or)\s+(?=[.!?](?:\s|$))/gi, "")
      .replace(/\s+([.!?])/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
  }

  function captureUtterance(text: string) {
    const cleaned = cleanForSpeech(text);
    if (cleaned) state.currentUtterances.push(cleaned);
  }

  function enqueueSpeech(text: string) {
    if (!text || state.mode === "gagged") return;

    state.queue.push(...splitSpeechText(text));
    updateStatus();
    if (state.mode === "talking") void drainQueue();
  }

  function enqueueUncommittedUtterances() {
    const utterances = state.currentUtterances.slice(state.committedUtteranceCount);
    state.committedUtteranceCount = state.currentUtterances.length;
    enqueueSpeech(utterances.join(" "));
  }

  function ingestMarkdown(delta: string, flush = false) {
    state.messageMarkdown += delta;
    if (!flush) return;

    captureUtterance(stripFencedCode(state.messageMarkdown));
    resetAccumulator();
  }

  async function stopPlayback(clearQueue = true) {
    state.generation += 1;
    if (clearQueue) state.queue = [];
    state.processing = false;
    updateStatus();
    await state.playback?.cancel();
  }

  async function setSpeechPaused(ctx: ExtensionContext, paused: boolean): Promise<boolean> {
    const previousMode = state.mode;
    const targetMode: SpeechMode = paused ? "paused" : "talking";
    state.mode = targetMode;
    updateStatus();

    try {
      if (paused) await state.playback?.pause();
      else await state.playback?.resume();
    } catch {
      if (state.mode === targetMode) state.mode = previousMode;
      updateStatus();
      return false;
    }

    if (state.mode !== targetMode) return false;
    notify(ctx, paused ? "Speech paused at the current position" : "Speech continued from the paused position");
    if (!paused) void drainQueue();
    return true;
  }

  async function drainQueue() {
    if (state.processing || state.mode !== "talking") return;
    const playback = ensurePlayback();
    if (!playback) {
      state.queue = [];
      notify(state.activeContext, "Speech unavailable: OPENAI_API_KEY is not set.", "error");
      updateStatus();
      return;
    }

    state.processing = true;
    updateStatus();

    const generation = state.generation;
    try {
      while (state.mode === "talking" && state.queue.length > 0 && generation === state.generation) {
        const text = state.queue.shift();
        if (!text) continue;

        try {
          await playback.playChunk(text, state.playbackSpeed);
        } catch (error) {
          if (generation !== state.generation || error instanceof SpeechCancelledError) break;
          state.queue = [];
          notifySpeechError(error);
          break;
        } finally {
          if (generation === state.generation) updateStatus();
        }
      }
    } finally {
      if (generation === state.generation) state.processing = false;
      updateStatus();
    }
  }

  function questionText(args: unknown): string[] {
    if (!args || typeof args !== "object") return [];
    const value = args as Record<string, unknown>;
    const questions = Array.isArray(value.questions) ? value.questions : [value];

    return questions.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const question = item as Record<string, unknown>;
      if (typeof question.question !== "string") return [];

      const labels = Array.isArray(question.options)
        ? question.options.flatMap((option) => {
            if (!option || typeof option !== "object") return [];
            const label = (option as Record<string, unknown>).label;
            return typeof label === "string" ? [label] : [];
          })
        : [];

      return [labels.length > 0 ? `${question.question} Options: ${labels.join("; ")}.` : question.question];
    });
  }

  async function startTalking(ctx: ExtensionContext, utterances: string[], message: string): Promise<boolean> {
    const playback = ensurePlayback();
    if (!playback) {
      state.mode = "gagged";
      notify(ctx, "Speech unavailable: OPENAI_API_KEY is not set.", "error");
      updateStatus();
      return false;
    }

    try {
      await stopPlayback();
    } catch (error) {
      state.mode = "gagged";
      notifySpeechError(error);
      updateStatus();
      return false;
    }

    showDisclosure(ctx);
    await playback.resume();
    state.mode = "talking";
    const text = utterances.join(" ").trim();
    if (text) state.queue.push(...splitSpeechText(text));
    notify(ctx, message);
    updateStatus();
    void drainQueue();
    return true;
  }

  async function talkSpeech(ctx: ExtensionContext): Promise<void> {
    const newestUtterances = state.currentMessageStreaming
      ? []
      : state.currentMessageComplete
        ? state.currentUtterances
        : state.latestCompleteUtterances;
    const newest = newestUtterances.join(" ");
    await startTalking(
      ctx,
      newest ? [newest] : [],
      newest
        ? "Talking from the start of the newest complete message"
        : "Talking; waiting for the newest message to finish",
    );
  }

  async function gagSpeech(ctx: ExtensionContext): Promise<void> {
    state.mode = "gagged";
    try {
      await stopPlayback();
      notify(ctx, "Pi Talk gagged");
    } catch (error) {
      notifySpeechError(error);
    }
    updateStatus();
  }

  async function pauseSpeech(ctx: ExtensionContext): Promise<void> {
    if (state.mode === "gagged") {
      notify(ctx, "Pi Talk is gagged; use /talk first", "warning");
    } else if (state.mode === "paused") {
      notify(ctx, "Speech is already paused");
    } else {
      await setSpeechPaused(ctx, true);
    }
    updateStatus();
  }

  async function unpauseSpeech(ctx: ExtensionContext): Promise<void> {
    if (state.mode !== "paused") {
      notify(ctx, "Speech is not paused", "warning");
    } else {
      await setSpeechPaused(ctx, false);
    }
    updateStatus();
  }

  async function activateSpeechShortcut(ctx: ExtensionContext): Promise<void> {
    const action = primaryShortcutAction(state.mode);
    if (action === "talk") await talkSpeech(ctx);
    else if (action === "pause") await pauseSpeech(ctx);
    else await unpauseSpeech(ctx);
  }

  function describeState(): string {
    const activity = state.processing ? "playing" : "idle";
    const message = state.currentMessageStreaming
      ? "newest message streaming"
      : state.currentMessageComplete
        ? "newest message complete"
        : "no current complete message";
    return `${state.mode}; ${activity}; ${state.queue.length} queued; ${message}; speed ${formatPlaybackSpeed(state.playbackSpeed)}; model ${OPENAI_SPEECH_MODEL}; voice ${OPENAI_SPEECH_VOICE}`;
  }

  pi.on("session_start", async (_event, ctx) => {
    state.activeContext = ctx;
    state.mode = "gagged";
    state.processing = false;
    state.queue = [];
    state.playback = undefined;
    state.disclosureShown = false;
    state.currentMessageStreaming = false;
    state.currentMessageComplete = false;
    state.latestCompleteUtterances = [];
    state.seenQuestionCalls.clear();

    if (!process.env.OPENAI_API_KEY) {
      notify(ctx, "Pi Talk is gagged; OPENAI_API_KEY is not set", "warning");
    } else {
      notify(ctx, `Pi Talk loaded gagged at ${formatPlaybackSpeed(state.playbackSpeed)}. Use /talk to begin.`);
    }
    updateStatus();
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;

    if (state.mode === "talking") {
      try {
        await stopPlayback();
      } catch (error) {
        state.mode = "gagged";
        notifySpeechError(error);
      }
    }
    resetAccumulator();
    state.currentUtterances = [];
    state.committedUtteranceCount = 0;
    state.currentMessageStreaming = true;
    state.currentMessageComplete = false;
    updateStatus();
  });

  pi.on("message_update", async (event) => {
    if (event.assistantMessageEvent.type !== "text_delta") return;
    ingestMarkdown(event.assistantMessageEvent.delta);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    state.currentMessageStreaming = false;
    if (event.message.stopReason === "aborted") {
      resetAccumulator();
      state.currentMessageComplete = false;
    } else {
      ingestMarkdown("", true);
      state.currentMessageComplete = true;
      state.latestCompleteUtterances = [...state.currentUtterances];
      enqueueUncommittedUtterances();
    }
  });

  pi.on("tool_execution_start", async (event) => {
    const normalizedName = event.toolName.toLowerCase().replace(/[^a-z]/g, "");
    if (!normalizedName.includes("askuserquestion") || state.seenQuestionCalls.has(event.toolCallId)) return;

    state.seenQuestionCalls.add(event.toolCallId);
    const messageWasComplete = state.currentMessageComplete;
    ingestMarkdown("", true);

    const utterances = questionText(event.args);
    for (const utterance of utterances) captureUtterance(utterance);
    if (messageWasComplete) {
      state.latestCompleteUtterances = [...state.currentUtterances];
      enqueueUncommittedUtterances();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    state.mode = "gagged";
    try {
      await stopPlayback();
    } catch (error) {
      notifySpeechError(error);
    }
    resetAccumulator();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    state.playback = undefined;
    state.activeContext = undefined;
  });

  registerPiTalkShortcuts(pi, {
    activate: activateSpeechShortcut,
    adjustSpeed: (ctx, delta) => applyPlaybackSpeed(ctx, state.playbackSpeed + delta),
  });

  pi.registerCommand("talk", {
    description: "Speak the newest assistant message and automatically speak new messages",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "status") {
        notify(ctx, describeState());
      } else if (command === "test") {
        await startTalking(ctx, ["Pi Talk is ready."], "Talking; playing the audio test");
      } else if (command) {
        notify(ctx, "Usage: /talk [test|status]", "warning");
      } else {
        await talkSpeech(ctx);
      }
    },
  });

  pi.registerCommand("pause", {
    description: "Freeze speech at its exact playback position",
    handler: async (_args, ctx) => pauseSpeech(ctx),
  });

  pi.registerCommand("unpause", {
    description: "Continue speech from its exact paused position",
    handler: async (_args, ctx) => unpauseSpeech(ctx),
  });

  pi.registerCommand("speed", {
    description: "Open the playback-speed slider or set a rate from 0.50× to 3.00×",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (!command) {
        if (ctx.mode !== "tui") {
          notify(ctx, "The speed slider requires TUI mode; use /speed <0.50-3.00> instead", "warning");
          return;
        }
        await openPlaybackSpeedControl(ctx);
        return;
      }

      if (command === "reset") {
        applyPlaybackSpeed(ctx, DEFAULT_PLAYBACK_SPEED, true);
        return;
      }

      const requested = Number(command.replace(/[x×]$/, ""));
      if (!Number.isFinite(requested) || requested < MIN_PLAYBACK_SPEED || requested > MAX_PLAYBACK_SPEED) {
        notify(ctx, "Usage: /speed [0.50-3.00|reset]", "error");
        return;
      }

      applyPlaybackSpeed(ctx, requested);
    },
  });

  pi.registerCommand("gag", {
    description: "Stop speech, clear its queue, and disable automatic speaking",
    handler: async (_args, ctx) => gagSpeech(ctx),
  });
}
