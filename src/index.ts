import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "pi-talk";
const MAX_CHUNK_LENGTH = 360;
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

type UiLevel = "info" | "warning" | "error";

type SpeechState = {
  enabled: boolean;
  paused: boolean;
  processing: boolean;
  queue: string[];
  currentController?: AbortController;
  currentPlayer?: ChildProcessWithoutNullStreams;
  generation: number;
  activeContext?: ExtensionContext;
  markdownCarry: string;
  proseBuffer: string;
  insideFence: boolean;
  currentUtterances: string[];
  lastUtterances: string[];
  seenQuestionCalls: Set<string>;
};

export default function piSpeakPrototype(pi: ExtensionAPI) {
  const state: SpeechState = {
    enabled: process.env.PI_SPEAK_ENABLED !== "0",
    paused: false,
    processing: false,
    queue: [],
    generation: 0,
    markdownCarry: "",
    proseBuffer: "",
    insideFence: false,
    currentUtterances: [],
    lastUtterances: [],
    seenQuestionCalls: new Set(),
  };

  function notify(ctx: ExtensionContext | undefined, message: string, level: UiLevel = "info") {
    if (ctx?.hasUI) ctx.ui.notify(message, level);
  }

  function updateStatus() {
    const ctx = state.activeContext;
    if (!ctx?.hasUI) return;

    let label = "speech on";
    if (!state.enabled) label = "speech off";
    else if (state.paused) label = "speech paused";
    else if (state.processing || state.queue.length > 0) label = `speaking (${state.queue.length} queued)`;

    ctx.ui.setStatus(STATUS_ID, label);
  }

  function resetAccumulator() {
    state.markdownCarry = "";
    state.proseBuffer = "";
    state.insideFence = false;
  }

  function cleanForSpeech(text: string): string {
    return text
      .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
      .replace(/`[^`]*`/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/^\s{0,3}(?:#{1,6}|[-*+] |\d+[.)] )/gm, "")
      .replace(/[>*_~]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function enqueue(text: string, remember = true) {
    if (!state.enabled) return;
    const cleaned = cleanForSpeech(text);
    if (!cleaned) return;

    state.queue.push(cleaned);
    if (remember) state.currentUtterances.push(cleaned);
    updateStatus();
    void drainQueue();
  }

  function findBoundary(text: string): number {
    const sentence = /[.!?](?:["')\]]{0,2})(?:\s+|$)/g.exec(text);
    const paragraph = /\n\s*\n/.exec(text);

    const sentenceEnd = sentence ? sentence.index + sentence[0].length : -1;
    const paragraphEnd = paragraph ? paragraph.index + paragraph[0].length : -1;

    if (sentenceEnd >= 0 && paragraphEnd >= 0) return Math.min(sentenceEnd, paragraphEnd);
    return Math.max(sentenceEnd, paragraphEnd);
  }

  function drainProse(flush: boolean) {
    while (state.proseBuffer) {
      let cut = findBoundary(state.proseBuffer);

      if (cut < 0 && state.proseBuffer.length > MAX_CHUNK_LENGTH) {
        cut = state.proseBuffer.lastIndexOf(" ", MAX_CHUNK_LENGTH);
        if (cut < MAX_CHUNK_LENGTH / 2) cut = MAX_CHUNK_LENGTH;
      }

      if (cut < 0) {
        if (flush) {
          enqueue(state.proseBuffer);
          state.proseBuffer = "";
        }
        return;
      }

      enqueue(state.proseBuffer.slice(0, cut));
      state.proseBuffer = state.proseBuffer.slice(cut);
    }
  }

  function ingestMarkdown(delta: string, flush = false) {
    state.markdownCarry += delta;
    const safeEnd = flush ? state.markdownCarry.length : Math.max(0, state.markdownCarry.length - 2);
    let index = 0;
    let prose = "";

    while (index < safeEnd) {
      const marker = state.markdownCarry.slice(index, index + 3);
      if (marker === "```" || marker === "~~~") {
        state.insideFence = !state.insideFence;
        index += 3;
        continue;
      }

      if (!state.insideFence) prose += state.markdownCarry[index];
      index += 1;
    }

    state.markdownCarry = state.markdownCarry.slice(index);
    state.proseBuffer += prose;
    drainProse(flush);

    if (flush) {
      resetAccumulator();
    }
  }

  function stopPlayback(clearQueue = true) {
    state.generation += 1;
    state.currentController?.abort();
    state.currentController = undefined;

    if (state.currentPlayer) {
      // A paused child has already received SIGSTOP, which makes ChildProcess.killed
      // unreliable as an indication that the process has exited.
      state.currentPlayer.kill("SIGCONT");
      state.currentPlayer.kill("SIGTERM");
    }
    state.currentPlayer = undefined;

    if (clearQueue) state.queue = [];
    state.processing = false;
    state.paused = false;
    updateStatus();
  }

  async function playWithOpenAI(text: string, generation: number) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

    const controller = new AbortController();
    state.currentController = controller;

    const response = await fetch(OPENAI_SPEECH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.PI_SPEAK_MODEL || "gpt-4o-mini-tts",
        voice: process.env.PI_SPEAK_VOICE || "marin",
        input: text,
        response_format: "wav",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`OpenAI speech failed (${response.status}): ${detail}`);
    }
    if (!response.body) throw new Error("OpenAI speech returned no audio body");
    if (generation !== state.generation) return;

    const player = spawn(process.env.PI_SPEAK_PLAYER || "ffplay", [
      "-nodisp",
      "-autoexit",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
    ]);
    state.currentPlayer = player;

    let stderr = "";
    player.stderr.on("data", (chunk) => {
      if (stderr.length < 500) stderr += String(chunk);
    });

    const closed = once(player, "close") as Promise<[number | null, NodeJS.Signals | null]>;
    await pipeline(Readable.fromWeb(response.body as never), player.stdin);
    const [code] = await closed;

    if (generation === state.generation && code !== 0) {
      throw new Error(`ffplay exited with ${code}: ${stderr.trim() || "unknown playback error"}`);
    }
  }

  async function drainQueue() {
    if (state.processing || state.paused || !state.enabled) return;
    state.processing = true;
    updateStatus();

    const generation = state.generation;
    try {
      while (state.enabled && !state.paused && state.queue.length > 0 && generation === state.generation) {
        const text = state.queue.shift();
        if (!text) continue;

        try {
          await playWithOpenAI(text, generation);
        } catch (error) {
          if (generation !== state.generation || (error instanceof Error && error.name === "AbortError")) break;
          notify(state.activeContext, error instanceof Error ? error.message : String(error), "error");
        } finally {
          state.currentController = undefined;
          state.currentPlayer = undefined;
          updateStatus();
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

  pi.on("session_start", async (_event, ctx) => {
    state.activeContext = ctx;
    state.seenQuestionCalls.clear();

    if (!process.env.OPENAI_API_KEY) {
      state.enabled = false;
      notify(ctx, "Pi Talk disabled: OPENAI_API_KEY is not set", "warning");
    } else {
      notify(ctx, "Pi Talk prototype loaded. Use /speak for controls.");
    }
    updateStatus();
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;
    resetAccumulator();
    state.currentUtterances = [];
  });

  pi.on("message_update", async (event) => {
    if (!state.enabled || event.assistantMessageEvent.type !== "text_delta") return;
    ingestMarkdown(event.assistantMessageEvent.delta);
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    if (event.message.stopReason === "aborted") resetAccumulator();
    else ingestMarkdown("", true);

    state.lastUtterances = [...state.currentUtterances];
  });

  pi.on("tool_execution_start", async (event) => {
    const normalizedName = event.toolName.toLowerCase().replace(/[^a-z]/g, "");
    if (!normalizedName.includes("askuserquestion") || state.seenQuestionCalls.has(event.toolCallId)) return;

    state.seenQuestionCalls.add(event.toolCallId);
    ingestMarkdown("", true);

    const utterances = questionText(event.args);
    for (const utterance of utterances) enqueue(utterance);
    if (utterances.length > 0) state.lastUtterances = [...utterances];
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopPlayback();
    resetAccumulator();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    state.activeContext = undefined;
  });

  pi.registerCommand("speak", {
    description: "Control OpenAI speech: on, off, stop, pause, resume, replay, test, status",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      switch (command) {
        case "on":
          if (!process.env.OPENAI_API_KEY) {
            notify(ctx, "OPENAI_API_KEY is not set", "error");
            break;
          }
          state.enabled = true;
          notify(ctx, "Speech enabled");
          void drainQueue();
          break;
        case "off":
          state.enabled = false;
          stopPlayback();
          resetAccumulator();
          notify(ctx, "Speech disabled");
          break;
        case "stop":
          stopPlayback();
          resetAccumulator();
          notify(ctx, "Speech stopped");
          break;
        case "pause":
          state.paused = true;
          state.currentPlayer?.kill("SIGSTOP");
          notify(ctx, "Speech paused");
          break;
        case "resume":
          state.paused = false;
          state.currentPlayer?.kill("SIGCONT");
          notify(ctx, "Speech resumed");
          void drainQueue();
          break;
        case "replay":
          if (state.lastUtterances.length === 0) notify(ctx, "Nothing to replay", "warning");
          else {
            state.queue.push(...state.lastUtterances);
            notify(ctx, "Replaying last response");
            void drainQueue();
          }
          break;
        case "test":
          enqueue("Pi speech is ready.", false);
          break;
        case "status":
          notify(
            ctx,
            `Speech ${state.enabled ? "on" : "off"}; ${state.paused ? "paused" : "running"}; ${state.queue.length} queued; voice ${process.env.PI_SPEAK_VOICE || "marin"}`,
          );
          break;
        default:
          notify(ctx, "Usage: /speak on|off|stop|pause|resume|replay|test|status");
      }

      updateStatus();
    },
  });
}
