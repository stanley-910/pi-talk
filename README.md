# Pi Talk

Pi Talk is a macOS Pi extension that reads completed assistant responses aloud through OpenAI text-to-speech while preserving explicit local playback control.

It starts **Gagged**. Speech begins only after `/talk`, and the first activation in every session displays the required AI-voice and OpenAI data-retention disclosure before audio starts.

## Speech contract

Pi Talk:

- waits for a complete assistant response before sending speech text;
- removes fenced code, common delimited LaTeX, raw URLs, and basic Markdown syntax;
- speaks assistant prose, inline-code text, and structured question/option labels;
- splits only long cleaned messages into ordered semantic chunks capped at 1,800 UTF-8 bytes;
- sends one chunk at a time to `POST /v1/audio/speech` using pinned `gpt-4o-mini-tts-2025-12-15`, voice `marin`, streamed WAV, and API speed `1.0`;
- pipes response bytes with backpressure into one sequential `mpv` process forced to WAV input;
- uses mpv playback speed and JSON IPC for exact-position pause/resume;
- performs no prefetch and no automatic request retry;
- discards the rest of a message after any current-chunk failure;
- lets the newest turn win while Talking, with bounded HTTP/body/player teardown before replacement playback.

The HTTP lifecycle uses a 15-second response-header deadline, a 10-second response-body idle deadline, and a 120-second total chunk deadline. Cancellation aborts the request and response reader, closes player stdin and IPC, sends `SIGTERM`, escalates to `SIGKILL`, and waits for process close. Expected supersession errors remain silent.

## Privacy and disclosure

Before first playback each session, Pi Talk states:

> **AI voice:** Pi Talk sends cleaned assistant text to OpenAI to generate speech. OpenAI may retain API content for up to 30 days for abuse monitoring unless your organization has approved data-retention controls. Audio is streamed to a local player and is not saved by Pi Talk.

While active, the footer includes `AI voice · OpenAI`. Pi Talk does not intentionally log or persist:

- API keys or authorization headers;
- original or cleaned spoken text;
- response audio bytes;
- raw OpenAI error bodies;
- environment dumps.

Provider and playback failures use sanitized notifications. OpenAI-side work or billing after client cancellation is not guaranteed to stop immediately, so Pi Talk does not prefetch future chunks.

## Requirements

- Pi
- Node.js 22+
- macOS
- `mpv` on `PATH` (`brew install mpv`)
- `OPENAI_API_KEY` in the environment

Optional environment variables:

```sh
export PI_SPEAK_PLAYER=mpv
export PI_TALK_SPEED=1.25
```

`PI_SPEAK_PLAYER` may select another mpv-compatible executable path; arbitrary player CLIs are not compatible. The model and voice are intentionally pinned contract values, not environment overrides.

## Run

From this project:

```sh
npm start
```

The development command uses `--no-extensions` so an installed Pi Talk package cannot load alongside the worktree copy and create duplicate commands or competing speech state.

To load the extension while working in another repository:

```sh
pi --no-extensions -e ~/Developer/pi-talk/src/index.ts
```

To run deterministic, non-billable tests:

```sh
npm test
```

## Controls

```text
/talk          Speak the newest complete message, then auto-speak completed new messages
/pause         Freeze audio at its exact playback position
/unpause       Continue from the exact paused position
/gag           Stop audio, clear queued speech, and disable auto-speaking
/speed         Open the keyboard playback-speed slider
/speed 1.25    Set playback speed directly for the next chunk
/speed reset   Restore 1.25× playback
/talk test     Activate Talking and play a short live OpenAI diagnostic
/talk status   Show playback, queue, model, voice, and speed state
```

### Direct keyboard shortcuts

Pi Talk requests three native Pi shortcuts:

| Pi shortcut | Gagged | Talking | Paused |
| --- | --- | --- | --- |
| `Ctrl+Shift+Space` | Start Talking | Pause | Unpause |
| `Ctrl+Shift+.` | Increase speed by `0.10×` | Increase speed by `0.10×` | Increase speed by `0.10×` |
| `Ctrl+Shift+,` | Decrease speed by `0.10×` | Decrease speed by `0.10×` | Decrease speed by `0.10×` |

Speed shortcuts use the same `0.50×–3.00×` bounds as `/speed`. Use `/gag` to stop playback, clear queued speech, and disable automatic speaking. No tmux or Herdr binding is required. After loading or `/reload`, check `/hotkeys` for all three shortcuts; Pi reports shortcut conflicts in its extension diagnostics.

A newer assistant message interrupts stale audio while Talking. Pi Talk waits for the new message to finish, then speaks it. While Paused, automatic `message_start` preserves the exact position and backlog; `/talk` explicitly discards stale paused audio and starts the newest complete message from its beginning.

The `/speed` slider uses `j` to speed up and `k` to slow down by `0.10×`, shifted `j`/`k` for `0.05×`, arrows for optional coarse control, Space to pause/unpause, `r` to reset, Enter to apply, and Escape or Ctrl+C to cancel. Outside the slider, `Ctrl+Shift+.` speeds up and `Ctrl+Shift+,` slows down by `0.10×`. Supported speed is `0.50×–3.00×`; changes apply to the next chunk through mpv's pitch-corrected playback speed, while active audio keeps its current rate.

## Manual live test checklist

Live tests call OpenAI and incur API cost. Run them only when intended.

1. Start Pi Talk and confirm it reports **Gagged**.
2. Run `/talk test`; confirm the disclosure appears before audio and the footer shows `AI voice · OpenAI`.
3. Ask for a normal prose response; confirm speech starts only after message completion and sounds continuous.
4. Ask for a response longer than 1,800 UTF-8 bytes; confirm all chunks play once, in order, with no overlap.
5. Ask for fenced and inline code; confirm prose and inline-code text are spoken while the fence is silent.
6. Trigger a structured question; confirm the question and option labels are spoken once without descriptions.
7. During long playback, run `/pause`, then `/unpause`; confirm exact-position continuation.
8. While Talking, submit a newer turn; confirm stale audio stops promptly and no old audio resumes.
9. Pause old audio, produce a newer response, then run `/talk`; confirm the paused player is discarded before new playback.
10. Change `/speed` during playback; confirm only the next chunk uses the new speed.
11. Run `/gag` during playback; confirm audio stops, queued chunks are discarded, and later messages remain silent.
12. Exit or reload Pi during playback; confirm no Pi Talk `mpv` process remains.
13. Temporarily use an invalid API key; confirm the UI shows a sanitized authentication error without provider body text.
14. After cancellation/error testing, run `pgrep -fl mpv`; confirm Pi Talk left no child process.
15. Press `Ctrl+Shift+Space` while Gagged, Talking, and Paused; confirm it cycles through Talk, Pause, and Unpause without inserting text into the editor.
16. Press `Ctrl+Shift+.` and `Ctrl+Shift+,`; confirm the footer and notification move by `0.10×`, respect the speed bounds, and do not insert punctuation into the editor.

## Automated coverage

`npm test` uses fake HTTP streams and fake player processes. It verifies:

- Unicode-safe semantic chunk bounds and ordering;
- the exact pinned OpenAI request body and forced-WAV mpv arguments;
- incremental response streaming and backpressure handling;
- cancellation before headers and during playback;
- bounded cancellation when response-stream cleanup never settles;
- mpv JSON IPC pause/resume without process suspension, including bounded control-failure teardown;
- direct talk/pause and speed shortcuts sharing slash-command state and speed bounds;
- process/stdin failures and `SIGTERM` to `SIGKILL` escalation;
- header, body-idle, and total deadlines;
- failed-cleanup poisoning that blocks unsafe replacement playback;
- no retry and sanitized provider failures;
- rejection of overlapping playback;
- LaTeX removal without swallowing ordinary currency prose.

See [`NOTES.md`](NOTES.md) for the earlier live prototype observations that led to this contract.
