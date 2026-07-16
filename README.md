# Pi Talk

> **PROTOTYPE — throw this away or absorb the result into a real Pi package.**

## Question this prototype answers

Can a Pi extension read streamed assistant prose and structured grilling questions through OpenAI without blocking the TUI, repeating the final response, reading fenced code, or leaving audio playback behind?

The prototype buffers each complete assistant response, removes fenced code and common delimited LaTeX, sends the remaining body to `gpt-4o-mini-tts` in one request, and pipes the streamed WAV response into `ffplay`. It separately watches question-tool execution so tool-only questions are spoken too.

## Scope

Included:

- Pi only
- OpenAI `gpt-4o-mini-tts`
- One TTS request per complete assistant response
- Structured `ask_user_question` question and option labels
- Fenced-code suppression and best-effort common LaTeX filtering
- Spoken inline code with backtick delimiters removed
- Basic Markdown cleanup
- Explicit Gagged, Talking, and Paused playback states
- `/talk`, `/pause`, `/unpause`, and `/gag` controls
- `/speed` keyboard slider and direct speed setting
- `ffplay` `atempo` playback from `0.50×` to `2.00×`
- macOS playback through `ffplay`

Not included:

- Claude Code
- Multiple providers
- Persistence
- Polished configuration UI
- Reading thinking, tool output, option descriptions, or fenced code

## Requirements

- Pi
- Node.js 22+
- `ffplay` on `PATH` (provided by FFmpeg)
- `OPENAI_API_KEY` in the environment

Optional environment variables:

```sh
export PI_SPEAK_VOICE=marin
export PI_SPEAK_MODEL=gpt-4o-mini-tts
export PI_SPEAK_PLAYER=ffplay
export PI_TALK_SPEED=1.25
```

## Run

From this project:

```sh
npm start
```

Pi Talk starts **Gagged**. To activate it and confirm OpenAI plus `ffplay` work, run:

```text
/talk test
```

To load the prototype while working in another repository:

```sh
pi -e ~/Developer/pi-talk/src/index.ts
```

## Controls

```text
/talk          Speak the newest complete message, then auto-speak completed new messages
/pause         Freeze audio at its exact playback position
/unpause       Continue from the exact paused position
/gag           Stop audio, clear queued speech, and disable auto-speaking
/speed         Open the keyboard playback-speed slider
/speed 1.25    Set playback speed directly for the next utterance
/speed reset   Restore 1.25× playback
/talk test     Activate Talking and play a short diagnostic
/talk status   Show the full prototype state, including speed
```

A newer assistant message interrupts stale audio while Talking. Pi Talk waits for that message to finish, then speaks it in one request for natural continuity. While Paused, the exact position and queued backlog are preserved for `/unpause`; `/talk` instead discards that stale backlog and starts the newest complete message from its beginning.

The `/speed` slider uses `←`/`→` for `0.10×` changes, `Shift+←`/`Shift+→` for `0.05×`, `r` to reset, `Enter` to apply, and `Esc` to cancel. A changed speed applies to the next utterance; active audio keeps its current rate. Slider changes are in-memory only, while `PI_TALK_SPEED` sets the startup default.

Semantic 2–3 sentence chunks with one-ahead prefetch remain a possible follow-up if waiting for message completion feels too slow.

## What to try

1. `/talk test` — confirm OpenAI and `ffplay` work.
2. `/gag`, ask for a response, then `/talk` — hear the newest response from its beginning.
3. Ask Pi for a long prose explanation — speech should begin after the message completes and flow continuously.
4. Invoke a skill that asks a structured question — hear the question and concise option labels.
5. Ask for fenced code and inline code — speak prose and inline code, but skip fences. Common LaTeX filtering is best effort.
6. `/pause` during a long sentence, then `/unpause` — continue from the exact position.
7. Pause old audio, produce a newer response, then `/talk` — discard the backlog and start the newer response from its beginning.
8. Open `/speed`, set `1.50×`, and confirm the next response is faster without a pitch shift.
9. Change speed during playback and confirm only the following utterance uses the new rate.
10. `/gag` or exit Pi during playback — audio should stop immediately.

Record what feels wrong in [NOTES.md](NOTES.md). The prototype is successful when it reveals the desired queueing, interruption, and question-reading behavior—not when the code looks production-ready.
