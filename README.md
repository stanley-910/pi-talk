# Pi Talk

> **PROTOTYPE — throw this away or absorb the result into a real Pi package.**

## Question this prototype answers

Can a Pi extension read streamed assistant prose and structured grilling questions through OpenAI without blocking the TUI, repeating the final response, reading fenced code, or leaving audio playback behind?

The prototype buffers Pi's token deltas until sentence boundaries, sends each sentence to `gpt-4o-mini-tts`, and pipes the streamed WAV response into `ffplay`. It separately watches question-tool execution so tool-only questions are spoken too.

## Scope

Included:

- Pi only
- OpenAI `gpt-4o-mini-tts`
- Sentence-level streaming
- Structured `ask_user_question` question and option labels
- Fenced-code suppression and basic Markdown cleanup
- `/speak` controls
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
export PI_SPEAK_ENABLED=1
export PI_SPEAK_PLAYER=ffplay
```

## Run

From this project:

```sh
npm start
```

Then run:

```text
/speak test
```

To load the prototype while working in another repository:

```sh
pi -e ~/Developer/pi-talk/src/index.ts
```

## Controls

```text
/speak on
/speak off
/speak stop
/speak pause
/speak resume
/speak replay
/speak test
/speak status
```

Speech starts enabled unless `PI_SPEAK_ENABLED=0`. If `OPENAI_API_KEY` is missing, the extension starts disabled.

## What to try

1. `/speak test` — confirm OpenAI and `ffplay` work.
2. Ask Pi for a long prose explanation — speech should begin after the first sentence.
3. Invoke a skill that asks a structured question — hear the question and concise option labels.
4. Ask for code — prose should be spoken and fenced code skipped.
5. Use pause, resume, stop, and replay during a long response.
6. Exit or reload Pi during playback — audio should stop.

Record what feels wrong in [NOTES.md](NOTES.md). The prototype is successful when it reveals the desired queueing, interruption, and question-reading behavior—not when the code looks production-ready.
