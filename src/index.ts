import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "pi-talk";
const OPENAI_SPEECH_URL = "https://api.openai.com/v1/audio/speech";

type UiLevel = "info" | "warning" | "error";
type SpeechMode = "gagged" | "talking" | "paused";

type SpeechState = {
  mode: SpeechMode;
  processing: boolean;
  queue: string[];
  currentController?: AbortController;
  currentPlayer?: ChildProcessWithoutNullStreams;
  generation: number;
  activeContext?: ExtensionContext;
  messageMarkdown: string;
  currentUtterances: string[];
  latestCompleteUtterances: string[];
  committedUtteranceCount: number;
  currentMessageStreaming: boolean;
  currentMessageComplete: boolean;
  seenQuestionCalls: Set<string>;
};

export default function piSpeakPrototype(pi: ExtensionAPI) {
  const state: SpeechState = {
    mode: "gagged",
    processing: false,
    queue: [],
    generation: 0,
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

  function updateStatus() {
    const ctx = state.activeContext;
    if (!ctx?.hasUI) return;

    let label: string = state.mode;
    if (state.mode === "talking" && (state.processing || state.queue.length > 0)) {
      label = `talking (${state.queue.length} queued)`;
    }

    ctx.ui.setStatus(STATUS_ID, label);
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
    return text
      .replace(/\$\$[\s\S]*?\$\$/g, " ")
      .replace(/\\\[[\s\S]*?\\\]/g, " ")
      .replace(/\\begin\{([^}]+)}[\s\S]*?\\end\{\1}/g, " ")
      .replace(/\\\([\s\S]*?\\\)/g, " ")
      .replace(/\$[\s\S]*?\$/g, " ")
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

    state.queue.push(text);
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
    if (state.mode === "paused") player.kill("SIGSTOP");

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
    if (state.processing || state.mode !== "talking") return;
    state.processing = true;
    updateStatus();

    const generation = state.generation;
    try {
      while (state.mode === "talking" && state.queue.length > 0 && generation === state.generation) {
        const text = state.queue.shift();
        if (!text) continue;

        try {
          await playWithOpenAI(text, generation);
        } catch (error) {
          if (generation !== state.generation || (error instanceof Error && error.name === "AbortError")) break;
          notify(state.activeContext, error instanceof Error ? error.message : String(error), "error");
        } finally {
          if (generation === state.generation) {
            state.currentController = undefined;
            state.currentPlayer = undefined;
            updateStatus();
          }
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

  function startTalking(ctx: ExtensionContext, utterances: string[], message: string): boolean {
    if (!process.env.OPENAI_API_KEY) {
      notify(ctx, "OPENAI_API_KEY is not set", "error");
      return false;
    }

    stopPlayback();
    state.mode = "talking";
    state.queue.push(...utterances);
    notify(ctx, message);
    updateStatus();
    void drainQueue();
    return true;
  }

  function describeState(): string {
    const activity = state.processing ? "playing" : "idle";
    const message = state.currentMessageStreaming
      ? "newest message streaming"
      : state.currentMessageComplete
        ? "newest message complete"
        : "no current complete message";
    return `${state.mode}; ${activity}; ${state.queue.length} queued; ${message}; voice ${process.env.PI_SPEAK_VOICE || "marin"}`;
  }

  pi.on("session_start", async (_event, ctx) => {
    state.activeContext = ctx;
    state.mode = "gagged";
    state.currentMessageStreaming = false;
    state.currentMessageComplete = false;
    state.latestCompleteUtterances = [];
    state.seenQuestionCalls.clear();

    if (!process.env.OPENAI_API_KEY) {
      notify(ctx, "Pi Talk is gagged; OPENAI_API_KEY is not set", "warning");
    } else {
      notify(ctx, "Pi Talk prototype loaded gagged. Use /talk to begin.");
    }
    updateStatus();
  });

  pi.on("message_start", async (event) => {
    if (event.message.role !== "assistant") return;

    if (state.mode === "talking") stopPlayback();
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
    stopPlayback();
    resetAccumulator();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    state.activeContext = undefined;
  });

  pi.registerCommand("talk", {
    description: "Speak the newest assistant message and automatically speak new messages",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();

      if (command === "status") {
        notify(ctx, describeState());
      } else if (command === "test") {
        startTalking(ctx, ["Pi Talk is ready."], "Talking; playing the audio test");
      } else if (command) {
        notify(ctx, "Usage: /talk [test|status]", "warning");
      } else {
        const newestUtterances = state.currentMessageStreaming
          ? []
          : state.currentMessageComplete
            ? state.currentUtterances
            : state.latestCompleteUtterances;
        const newest = newestUtterances.join(" ");
        startTalking(
          ctx,
          newest ? [newest] : [],
          newest
            ? "Talking from the start of the newest complete message"
            : "Talking; waiting for the newest message to finish",
        );
      }
    },
  });

  pi.registerCommand("pause", {
    description: "Freeze speech at its exact playback position",
    handler: async (_args, ctx) => {
      if (state.mode === "gagged") {
        notify(ctx, "Pi Talk is gagged; use /talk first", "warning");
      } else if (state.mode === "paused") {
        notify(ctx, "Speech is already paused");
      } else {
        state.mode = "paused";
        state.currentPlayer?.kill("SIGSTOP");
        notify(ctx, "Speech paused at the current position");
      }
      updateStatus();
    },
  });

  pi.registerCommand("unpause", {
    description: "Continue speech from its exact paused position",
    handler: async (_args, ctx) => {
      if (state.mode !== "paused") {
        notify(ctx, "Speech is not paused", "warning");
      } else {
        state.mode = "talking";
        state.currentPlayer?.kill("SIGCONT");
        notify(ctx, "Speech continued from the paused position");
        void drainQueue();
      }
      updateStatus();
    },
  });

  pi.registerCommand("gag", {
    description: "Stop speech, clear its queue, and disable automatic speaking",
    handler: async (_args, ctx) => {
      state.mode = "gagged";
      stopPlayback();
      notify(ctx, "Pi Talk gagged");
      updateStatus();
    },
  });
}
