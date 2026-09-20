# Pi Talk

Pi Talk is a [Pi](https://pi.dev) extension for macOS that reads completed assistant responses aloud through OpenAI text-to-speech, streamed into a local `mpv` player, with pause, resume, and speed controls that act on the audio already playing.

It loads **Gagged** and stays silent until you run `/talk`. The first time speech is activated in a session, Pi Talk shows an AI-voice and OpenAI data-handling disclosure before any audio plays.

## Quickstart

Prerequisites:

- macOS (the only tested platform for this release)
- Pi 0.85.1 or later on Node.js 22.19 or later (Pi's own requirement)
- `mpv` on your `PATH`: `brew install mpv`
- An OpenAI API key with access to the `gpt-4o-mini-tts` model, exported as `OPENAI_API_KEY`

Install, then start Pi:

```sh
pi install npm:@twinfantasyfan/pi-talk
export OPENAI_API_KEY=sk-...
pi
```

Pi Talk announces that it loaded gagged and shows `■ · 1.25×` in the footer. Run `/talk test` to hear a short diagnostic sentence, or ask a question and run `/talk` to have the newest complete response read aloud and every later response spoken automatically.

Every spoken message is a paid OpenAI request billed to your key at the [audio model rate](https://openai.com/api/pricing/). `/talk test` also makes a live request. Nothing is sent until you activate speech; loading the extension makes no network requests.

To try it without installing:

```sh
pi -e npm:@twinfantasyfan/pi-talk
```

## Controls

```text
/talk          Speak the newest complete message, then auto-speak completed new messages
/pause         Freeze audio at its exact playback position
/unpause       Continue from the exact paused position
/gag           Stop audio, clear queued speech, and disable auto-speaking
/speed         Open the keyboard playback-speed slider
/speed 1.25    Set playback speed directly, retuning audio already playing
/speed reset   Restore 1.25× playback
/talk test     Activate Talking and play a short live OpenAI diagnostic (billable)
/talk status   Show playback, queue, model, voice, and speed state
```

Pi Talk registers three native Pi shortcuts:

| Pi shortcut | Gagged | Talking | Paused |
| --- | --- | --- | --- |
| `Ctrl+Shift+Space` | Start Talking | Pause | Unpause |
| `Ctrl+Shift+.` | Speed up by `0.10×` | Speed up by `0.10×` | Speed up by `0.10×` |
| `Ctrl+Shift+,` | Slow down by `0.10×` | Slow down by `0.10×` | Slow down by `0.10×` |

Speed is bounded to `0.50×–3.00×` and defaults to `1.25×` (override with `PI_TALK_SPEED`). Changes apply immediately through mpv's pitch-corrected playback rate: audio already playing retunes mid-sentence, and the next chunk starts at the new rate. The footer shows the state and speed, for example `▶ · 1.25×`, `⏸ · 1.25×`, or `■ · 1.25×`.

Some terminals do not deliver `Ctrl+Shift` chords as distinct keys, and other extensions or your keybindings may claim them. Run `/hotkeys` after loading or `/reload` to see what Pi actually bound; Pi reports conflicts in its extension diagnostics. The slash commands always work regardless of shortcuts.

The `/speed` slider uses `j`/`k` to move by `0.10×`, `J`/`K` by `0.05×`, arrow keys for coarse steps, Space to pause or unpause, `r` to reset, Enter to apply, and Escape or Ctrl+C to cancel. The slider previews each draft rate live and restores the committed rate if you cancel.

## What is sent to OpenAI

Before first playback in each session, Pi Talk states:

> **AI voice:** Pi Talk sends cleaned assistant text to OpenAI to generate speech. OpenAI may retain API content for up to 30 days for abuse monitoring unless your organization has approved data-retention controls. Audio is streamed to a local player and is not saved by Pi Talk.

Concretely, Pi Talk sends the assistant's completed message text, after cleaning, to `POST https://api.openai.com/v1/audio/speech` using your `OPENAI_API_KEY`. Your prompts, tool output, and file contents are not sent by Pi Talk; only the assistant's prose reaches OpenAI, and only after you activate speech. OpenAI's published API data policy states that API content is not used for training by default and that abuse-monitoring logs are kept for up to 30 days unless your organization has been approved for zero data retention; check [OpenAI's current policy](https://developers.openai.com/api/docs/guides/your-data) rather than relying on this summary.

Pi Talk does not intentionally log or persist API keys or authorization headers, original or cleaned spoken text, response audio bytes, raw OpenAI error bodies, or environment dumps. Provider and playback failures surface as sanitized one-line notifications.

## How it speaks

Pi Talk:

- waits for a complete assistant response before sending any speech text;
- removes fenced code, common delimited LaTeX, raw URLs, and basic Markdown syntax;
- speaks assistant prose, inline-code text, and structured question and option labels;
- splits only long cleaned messages into ordered semantic chunks capped at 1,800 UTF-8 bytes;
- sends one chunk at a time using the pinned model `gpt-4o-mini-tts-2025-12-15`, voice `marin`, streamed WAV, and API speed `1.0`;
- pipes response bytes with backpressure into one sequential `mpv` process forced to WAV input;
- uses mpv's JSON IPC for exact-position pause and resume and for live speed changes;
- performs no prefetch and no automatic request retry in the extension, so cancelling never leaves a second request billing;
- discards the rest of a message after any chunk fails;
- lets the newest turn win while Talking, with bounded HTTP, body, and player teardown before replacement playback.

A newer assistant message interrupts stale audio while Talking; Pi Talk waits for the new message to finish, then speaks it. While Paused, a new message preserves the exact paused position and backlog; `/talk` explicitly discards stale paused audio and starts the newest complete message from its beginning.

Timeouts: a 15-second response-header deadline, a 10-second body-idle deadline, and a 120-second total chunk deadline that counts only unpaused time and, once the audio has fully arrived, stretches to the audio's own length at the slowest speed plus 30 seconds so a long chunk is never cut off mid-sentence. Cancellation aborts the request and response reader, closes player stdin and IPC, sends `SIGTERM`, escalates to `SIGKILL`, and waits for the process to close.

Audio is upmixed to stereo before output. macOS's coreaudio driver rejects the mono stream OpenAI sends, and mpv's AVFoundation fallback drops its two-second buffer at exit, which cut off the end of every chunk.

### One speaker per machine

Only one Pi instance speaks at a time, machine-wide. When a response finishes in one pane while another pane is still reading aloud, the second instance shows `⏳`, reports that it is waiting for another Pi Talk to finish, and starts once the first instance's message ends. A paused instance keeps the floor so nothing talks over its position; `/gag` in that pane hands the floor on. The lease is refreshed every 5 seconds and expires 15 seconds after its holder stops refreshing or exits, so a crashed instance never blocks the others. This coordination is best-effort and file-based; it has automated tests but has not been stress-tested across many simultaneous instances.

State lives in `~/.claude/cc-talk/` (override with `CC_TALK_STATE_DIR`): `talk.lock` is the floor lease, and `speaker.log` collects sanitized one-line failures with no keys, provider bodies, or spoken text. The directory name is inherited from the Claude Code prototype this extension was ported from.

## Configuration

```sh
export OPENAI_API_KEY=sk-...   # required; the extension reads only the environment
export PI_TALK_SPEED=1.25      # optional; initial playback speed, 0.50–3.00
export PI_SPEAK_PLAYER=mpv     # optional; path to an mpv-compatible executable
```

`PI_SPEAK_PLAYER` may point at another mpv build; arbitrary player CLIs are not compatible. The model and voice are intentionally pinned, not environment overrides.

## Troubleshooting

- **"Pi Talk is gagged; OPENAI_API_KEY is not set"** on load: export the key in the shell that starts Pi, then `/reload`.
- **"Speech unavailable: install mpv or configure PI_SPEAK_PLAYER"**: `brew install mpv`, or point `PI_SPEAK_PLAYER` at your mpv binary.
- **No audio but no error**: check the macOS output device, then run `/talk test`. A sanitized authentication error means the key is invalid or lacks audio-model access.
- **Shortcuts do nothing**: run `/hotkeys`; your terminal may not send `Ctrl+Shift` chords. Use the slash commands.
- **Audio keeps waiting (`⏳`)**: another Pi instance is speaking or paused. `/gag` there, or wait 15 seconds after it exits for the lease to expire.
- **Stray mpv after a crash**: `pgrep -fl mpv`; Pi Talk's players exit with the extension, but a hard-killed Pi may leave one to kill by hand.
- Remember that `/talk test` and every spoken message cost OpenAI API credit.

## Tested versions

This release was validated on macOS with Pi 0.85.1, Node.js 26.8.1 (Pi's minimum is 22.19), and mpv from Homebrew. Linux and Windows are untested and unsupported for this release. Other providers are not supported.

## Development

```sh
git clone https://github.com/stanley-910/pi-talk
cd pi-talk
npm install
npm test      # deterministic, no network, fake HTTP streams and fake players
npm start     # pi --no-extensions -e ./src/index.ts
```

`npm start` uses `--no-extensions` so an installed Pi Talk package cannot load alongside the checkout and create duplicate commands or competing speech state. To load the checkout while working in another repository:

```sh
pi --no-extensions -e ~/Developer/pi-talk/src/index.ts
```

### Automated coverage

`npm test` uses fake HTTP streams and fake player processes. It verifies Unicode-safe chunk bounds and ordering; the exact pinned OpenAI request body and forced-WAV mpv arguments; streaming and backpressure; cancellation before headers and during playback; bounded cancellation when stream cleanup never settles; mpv JSON IPC pause and resume with bounded control-failure teardown; talk, pause, and speed shortcuts sharing slash-command state; process and stdin failures with `SIGTERM` to `SIGKILL` escalation; header, body-idle, and total deadlines including the pause suspension and audio-length extension; failed-cleanup poisoning that blocks unsafe replacement playback; no retry and sanitized provider failures; rejection of overlapping playback; LaTeX removal without swallowing currency prose; the machine-wide floor lease; and the standalone speaker CLI's pidfile takeover, signalling, and prefetch handoff.

### Manual live test checklist

Live tests call OpenAI and incur API cost. Run them only when intended.

1. Start Pi Talk and confirm it reports **Gagged**.
2. Run `/talk test`; confirm the disclosure appears before audio and the footer shows `▶` and the current speed.
3. Ask for a normal prose response; confirm speech starts only after message completion and sounds continuous.
4. Ask for a response longer than 1,800 UTF-8 bytes; confirm all chunks play once, in order, with no overlap.
5. Ask for fenced and inline code; confirm prose and inline-code text are spoken while the fence is silent.
6. Trigger a structured question; confirm the question and option labels are spoken once without descriptions.
7. During long playback, run `/pause`, then `/unpause`; confirm exact-position continuation.
8. While Talking, submit a newer turn; confirm stale audio stops promptly and no old audio resumes.
9. Pause old audio, produce a newer response, then run `/talk`; confirm the paused player is discarded before new playback.
10. Change `/speed` during playback; confirm the audio changes rate without a pitch shift, and that cancelling the slider returns it to the committed rate.
11. Run `/gag` during playback; confirm audio stops, queued chunks are discarded, and later messages remain silent.
12. Exit or reload Pi during playback; confirm no Pi Talk `mpv` process remains.
13. Temporarily use an invalid API key; confirm the UI shows a sanitized authentication error without provider body text.
14. After cancellation and error testing, run `pgrep -fl mpv`; confirm Pi Talk left no child process.
15. Press `Ctrl+Shift+Space` while Gagged, Talking, and Paused; confirm it cycles through Talk, Pause, and Unpause without inserting text into the editor.
16. Press `Ctrl+Shift+.` and `Ctrl+Shift+,`; confirm the footer and notification move by `0.10×`, respect the speed bounds, and do not insert punctuation into the editor.
17. Open a second Pi with Pi Talk, make both speak; confirm the second shows `⏳` and starts after the first finishes.

### Standalone speaker CLI (development only)

The repository also contains `bin/cc-talk-speak`, which speaks arbitrary text through the same engine from any shell with no Pi session involved. It is **not part of the npm package** and is not a supported interface; it exists for development and for the Claude Code prototype this extension was ported from. It differs from the extension in several ways: it prefetches the next chunk while the current one plays, it runs as a detached daemon recorded in `~/.claude/cc-talk/speaker.pid`, it falls back to reading `export KEY=value` lines from `~/.secrets/env` when `OPENAI_API_KEY` is unset, it takes over playback immediately rather than waiting for the floor, and it needs Node.js 22.18 or 23.6 or later because it imports TypeScript through Node's native type stripping.

```sh
echo "Some prose to read aloud." | bin/cc-talk-speak
bin/cc-talk-speak --file /tmp/response.txt   # the file is deleted after it is read
bin/cc-talk-speak --stop                     # always exits 0, even with nothing playing
bin/cc-talk-speak --pause                    # freeze at the current position
bin/cc-talk-speak --unpause                  # continue from where it froze
```

See [`NOTES.md`](NOTES.md) for the live prototype observations that led to this contract.
