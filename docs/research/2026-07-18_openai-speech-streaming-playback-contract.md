# OpenAI speech streaming and macOS playback contract

**Issue:** [#4 — Determine OpenAI speech streaming and playback contract](https://github.com/stanley-910/pi-talk/issues/4)
**Source access/current date:** 2026-07-18
**Status:** production-architecture gate for v0.1
**Evidence labels:** **Documented** means an external primary source states the fact; **Observed** means this repository records a local prototype result; **Inference** means a conclusion from documented behavior; **Recommendation** defines the proposed product contract.

## Question and scope

This note answers:

1. What the current OpenAI Speech API supports and limits: models, input/rate limits, voices, output formats, byte-stream semantics, cancellation uncertainty, pricing, retention, and disclosure.
2. How WAV, headerless PCM, and compressed audio compare when streamed to a player on macOS.
3. Whether v0.1 should make one request per sentence.
4. What must happen to the HTTP request, response stream, queue, and `ffplay` process when a newer turn wins.
5. The exact request, playback, failure, privacy, disclosure, and verification contract to implement.

This is not a Realtime API design. OpenAI distinguishes bounded request-based text-to-speech from persistent Realtime sessions; the Speech endpoint can return audio incrementally, but it does not turn a bounded text request into a bidirectional realtime session ([OpenAI audio concepts](https://platform.openai.com/docs/guides/audio)).

## Executive decision

**Recommendation:** Do **not** use one request per sentence. Wait for a complete assistant message, clean it, split only when required into ordered semantic chunks of at most **1,800 UTF-8 bytes**, and make one sequential Speech request per chunk. Most short messages therefore use one request; sentence boundaries are split points, not request boundaries.

Use exactly:

- `POST https://api.openai.com/v1/audio/speech`
- model `gpt-4o-mini-tts-2025-12-15`
- voice `marin`
- `response_format: "wav"`
- `stream_format: "audio"`
- API speed `1.0`; retain local `ffplay` `atempo` for user playback speed
- stream response bytes directly to one `ffplay` process at a time with forced WAV demuxing
- no prefetch and no automatic retry in v0.1
- newest-winner epoch checks around every asynchronous boundary
- HTTP abort plus response-stream cancellation plus bounded `ffplay` termination

OpenAI documents WAV/PCM as its fastest formats and WAV as uncompressed audio suitable for low-latency use ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats)). WAV keeps format metadata in-band, unlike raw PCM, so it avoids an undocumented channel-count assumption while preserving the existing working pipe.

## Current repository state

The issue premise describes sentence-sized requests, but the checked-out implementation no longer does that:

- Text deltas accumulate until `message_end`; only then does the code flush and enqueue speech ([`src/index.ts` lines 421–450](../../src/index.ts#L421-L450)).
- Captured utterances are joined with spaces into one queue item ([`src/index.ts` lines 240–250](../../src/index.ts#L240-L250)). Therefore, absent a tool-question edge case, the present request unit is one cleaned, complete assistant message—not one sentence.
- Each queue item becomes one `POST /v1/audio/speech` request using configurable model/voice defaults and `response_format: "wav"` ([`src/index.ts` lines 272–292](../../src/index.ts#L272-L292)).
- The response body is piped to `ffplay -nodisp -autoexit -loglevel error -af … -i pipe:0` ([`src/index.ts` lines 301–324](../../src/index.ts#L301-L324)).
- The state already carries one `AbortController`, one child process, and a generation counter ([`src/index.ts` lines 19–35](../../src/index.ts#L19-L35)). `stopPlayback()` increments the generation, aborts the request, sends `SIGCONT` then `SIGTERM` to a possible paused player, clears the queue, and immediately drops its references ([`src/index.ts` lines 254–270](../../src/index.ts#L254-L270)).
- A new assistant message invokes that stop path only while mode is `talking`; `paused` deliberately retains old audio until an explicit command chooses a new winner ([`src/index.ts` lines 421–430](../../src/index.ts#L421-L430)).

**Observed:** The repository's live notes say sentence requests sounded slow and unnatural, with waits of about 4.2 s cold, then 1.0 s and 0.37 s between sentences; whole-paragraph audio sounded substantially more natural. The same notes report working streamed WAV, audible `marin`, exact-position pause/unpause, interruption, and no measured gap for a separate two-chunk prefetch experiment ([`NOTES.md`](../../NOTES.md)). The README likewise defines the current prototype as one request per complete response and leaves semantic chunk prefetch as a possible follow-up ([`README.md`](../../README.md)). These are local observations, not provider guarantees.

Current gaps that the production contract must close:

- no documented input-length guard or long-message chunking;
- alias model rather than a pinned snapshot;
- no explicit `stream_format`;
- no header, body-idle, or total timeout;
- no wait for player exit and no `SIGKILL` escalation;
- references are cleared before process termination is confirmed;
- only one response/controller can be represented, which is acceptable only if v0.1 forbids prefetch;
- no persistent AI-voice disclosure;
- provider errors may include up to 500 bytes of response text in the UI;
- no explicit privacy notice or redaction/logging contract.

## Verified OpenAI facts

### Models and request schema

**Documented:** OpenAI's generated TypeScript SDK, which states it is generated from OpenAI's OpenAPI specification, lists these Speech models: `tts-1`, `tts-1-hd`, `gpt-4o-mini-tts`, and `gpt-4o-mini-tts-2025-12-15` ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)). The model catalog lists the alias and `2025-12-15` snapshot and marks the older `2025-03-20` snapshot deprecated ([GPT-4o mini TTS model page](https://platform.openai.com/docs/models/gpt-4o-mini-tts)).

**Documented:** `gpt-4o-mini-tts` is OpenAI's newest/recommended Speech model and accepts style instructions; `tts-1` is the older lower-latency/lower-quality option and `tts-1-hd` is the older higher-quality option ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#text-to-speech-models)). Style `instructions` do not work with `tts-1` or `tts-1-hd`, and the schema allows generated-audio `speed` from `0.25` through `4.0` ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)).

**Documented:** The endpoint schema caps `input` at **4,096 characters**, while the GPT-4o mini TTS model page states a **2,000 input-token** maximum ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts), [model page](https://platform.openai.com/docs/models/gpt-4o-mini-tts)). Both limits must be respected.

**Recommendation/inference:** Use chunks no larger than **1,800 UTF-8 bytes**. OpenAI's `tiktoken` maps the `gpt-4o-` model prefix to `o200k_base`, and its BPE description says the token sequence is shorter than the corresponding bytes ([OpenAI `tiktoken` model mapping](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py), [`tiktoken` README](https://github.com/openai/tiktoken#what-is-bpe-anyway)). This byte cap is a conservative, dependency-free guard below both published limits. OpenAI does not explicitly promise that the Speech endpoint will always use that tokenizer; retain the unresolved-risk item and a non-retrying input-limit error path.

### Voices and formats

**Documented:** The detailed voice list contains 13 built-ins: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`, `marin`, and `cedar`; OpenAI recommends `marin` or `cedar` for best quality. The older `tts-1` models support only `alloy`, `ash`, `coral`, `echo`, `fable`, `onyx`, `nova`, `sage`, and `shimmer` ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#voice-options)). Custom voices exist only for eligible customers and require consent and sample recordings ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#custom-voices)).

**Documentation inconsistency:** The introduction of the same guide says “11 built-in voices,” while its detailed list and generated schema enumerate 13 ([speech guide](https://platform.openai.com/docs/guides/text-to-speech), [OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)). Treat the detailed list/schema as authoritative for implementation and verify the selected voice in a live smoke test.

**Documented:** Supported Speech output formats are `mp3`, `opus`, `aac`, `flac`, `wav`, and `pcm`; MP3 is the default. OpenAI recommends WAV or PCM for fastest response, describes WAV as uncompressed and low-latency, and defines PCM as headerless 24 kHz, signed 16-bit, little-endian samples ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats), [OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)). The guide does not specify PCM channel count.

### Streaming semantics

**Documented:** OpenAI says the Speech API supports realtime audio streaming using chunk transfer encoding, so playback can start before the complete file has been generated. Its official examples pipe streamed WAV to `ffplay` and stream PCM to a local audio player ([speech guide](https://platform.openai.com/docs/guides/text-to-speech#streaming-realtime-audio)).

**Documented:** The generated schema exposes `stream_format: "audio" | "sse"`; SSE is unavailable on `tts-1` and `tts-1-hd` ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)).

**Inference:** With `stream_format: "audio"`, the HTTP body is an ordered opaque audio-byte stream, not sentence-, word-, or sample-aligned application events. The documentation makes no chunk-boundary guarantee. Code must pipe bytes in order and must not interpret each network chunk as a playable linguistic unit.

**Inference:** “Chunk transfer encoding” describes incremental delivery, not an HTTP header contract that clients should enforce; HTTP protocol versions can frame bodies differently. Verify that bytes arrive before EOF, not that a particular transfer header exists.

### Rate limits

**Documented:** Rate limits apply at organization/project level, vary by model, may be shared, and can be exhausted independently by RPM or TPM. OpenAI exposes remaining/reset values in `x-ratelimit-*` response headers and recommends exponential backoff in general; failed requests still count toward per-minute limits ([rate-limit guide](https://platform.openai.com/docs/guides/rate-limits)).

**Documented:** Current `gpt-4o-mini-tts` limits are ([model page](https://platform.openai.com/docs/models/gpt-4o-mini-tts)):

| Usage tier | RPM | TPM |
|---|---:|---:|
| Free | Not supported | Not supported |
| Tier 1 | 500 | 50,000 |
| Tier 2 | 2,000 | 150,000 |
| Tier 3 | 5,000 | 600,000 |
| Tier 4 | 10,000 | 2,000,000 |
| Tier 5 | 10,000 | 8,000,000 |

Actual account limits remain dashboard/header values, not constants embedded in the client ([rate-limit guide](https://platform.openai.com/docs/guides/rate-limits#usage-tiers)).

### Pricing

**Documented:** GPT-4o mini TTS is priced at **$0.60 per 1M text-input tokens** and **$12.00 per 1M audio-output tokens** ([model page](https://platform.openai.com/docs/models/gpt-4o-mini-tts)). `tts-1` is **$15 per 1M input characters** and `tts-1-hd` is **$30 per 1M input characters** ([TTS-1 model page](https://platform.openai.com/docs/models/tts-1), [TTS-1 HD model page](https://platform.openai.com/docs/models/tts-1-hd)).

For GPT-4o mini TTS, nominal request cost is:

```text
(input_text_tokens × $0.60 / 1,000,000)
+ (generated_audio_tokens × $12.00 / 1,000,000)
```

**Inference:** There is no listed per-request Speech fee, so splitting identical text by sentence does not create a direct request surcharge. It does multiply RPM consumption and can marginally change audio duration/output tokens because every request establishes fresh prosody. The binary Speech response schema does not expose a usage object, so exact per-utterance cost attribution may require account-level usage data rather than the response body ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)).

### Retention and training

**Documented:** OpenAI says API data is not used to train or improve models unless the customer explicitly opts in. For `/v1/audio/speech`, default abuse-monitoring retention is **up to 30 days**, application-state retention is **none**, and the endpoint is eligible for approved Zero Data Retention; ZDR/MAM controls require approval and have documented exceptions ([OpenAI data-controls table](https://platform.openai.com/docs/guides/your-data#data-retention-controls-for-abuse-monitoring)).

**Inference:** “No application-state retention” is not the same as “nothing can be retained”: default abuse-monitoring logs may still contain customer content for up to 30 days. Product copy must state the latter, not merely promise that Pi Talk writes no audio file locally.

### Disclosure

**Documented:** OpenAI's usage policy, as quoted in the Speech guide, requires a **clear disclosure to end users that the TTS voice is AI-generated and not a human voice** ([speech guide](https://platform.openai.com/docs/guides/text-to-speech)).

## macOS streaming-playback trade-offs

`ffplay` is an FFmpeg/SDL test player, not an Apple-native product API; it supports `-nodisp`, `-f` to force input format, `-af` for an audio filter graph, and `-autoexit` after playback ([ffplay documentation](https://ffmpeg.org/ffplay.html#Main-options), [advanced options](https://ffmpeg.org/ffplay.html#Advanced-options)). FFmpeg's `pipe:` protocol reads stdin, is non-seekable, and notes that a smaller I/O block size can improve termination responsiveness ([FFmpeg pipe protocol](https://ffmpeg.org/ffmpeg-protocols.html#pipe)).

| Format | Network/CPU and startup | Pipe behavior | macOS v0.1 assessment |
|---|---|---|---|
| **WAV** | Uncompressed; larger than compressed formats, but OpenAI identifies it as low-latency and avoids decode overhead ([OpenAI format guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats)). | Header carries sample format/rate/channels. OpenAI officially demonstrates `curl … response_format: wav | ffplay -i -` ([streaming example](https://platform.openai.com/docs/guides/text-to-speech#streaming-realtime-audio)). Force `-f wav` to avoid generic probing; FFmpeg documents that larger probe windows can increase latency ([FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options)). | **Choose.** Existing prototype has passed locally; metadata stays in-band; bandwidth is acceptable for a localhost player fed from a single HTTPS response. |
| **Raw PCM (`s16le`)** | No container header or decoder; OpenAI also recommends it for fastest response and defines 24 kHz, signed 16-bit, little-endian samples ([OpenAI format guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats)). | Must force raw format and supply sample properties out-of-band. A likely command is `ffplay -f s16le -ar 24000 -ac 1 -i pipe:0`, but the `-ac 1` mono assumption is **not documented by OpenAI**. Raw data has no self-description. | Do not choose until a live test verifies channel count and byte alignment. It is a future native-audio candidate if measured WAV startup is insufficient. |
| **MP3 / Opus / AAC** | Smaller transfer, plus decoder/container work. OpenAI calls MP3 general-purpose, Opus low-latency internet streaming, and AAC a common platform format ([OpenAI format guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats)). | `ffplay` can probe/decode only formats enabled in the installed build; FFmpeg exposes `-formats` and `-decoders` to inspect that build ([ffplay generic options](https://ffmpeg.org/ffplay.html#Generic-options)). Compressed framing can be streamed, but exact startup buffering is codec/build-dependent. | Not justified for a local pipe unless measured network bandwidth dominates. Adds decoder/probing variables to cancellation and startup tests. |
| **FLAC** | Lossless compression and decode cost; OpenAI positions it for lossless archiving ([OpenAI format guide](https://platform.openai.com/docs/guides/text-to-speech#supported-output-formats)). | Stream-decodable in suitable FFmpeg builds, but not needed for ephemeral speech. | Reject for v0.1: no archive requirement and no advantage over WAV for this path. |
| **Apple-native PCM playback** | Removes the external process and permits direct buffer scheduling. Apple's Audio Queue Services supports linear PCM and native compressed formats with low-overhead playback on macOS; Apple notes the archived guide is no longer updated ([Apple Audio Queue Services guide](https://developer.apple.com/library/archive/documentation/MusicAudio/Conceptual/AudioQueueProgrammingGuide/Introduction/Introduction.html)). | Would require an AVFAudio/Audio Queue adapter, explicit audio format, queue lifecycle, and interruption handling instead of stdin/process signals. | Production follow-up, not v0.1. It can eliminate process races, but only after the PCM channel/format contract is verified. |

**Inference:** WAV's larger payload is unlikely to be the dominant v0.1 bottleneck compared with model generation and network first-byte time. That must be measured; it is not an OpenAI SLA.

## Sentence-request analysis

### Decision: one request per sentence is not the v0.1 contract

Suppose a workload has `T` assistant turns/minute and an average `S` spoken sentences/turn:

```text
per-message requests ≈ T RPM
per-sentence requests ≈ T × S RPM
```

At six turns/minute and eight sentences/turn, sentence splitting consumes about 48 RPM rather than 6 RPM. Ten simultaneous sessions would consume about 480 RPM, close to the documented Tier-1 500 RPM limit before unrelated project traffic; actual limits are account/project-specific ([model limits](https://platform.openai.com/docs/models/gpt-4o-mini-tts), [rate-limit guide](https://platform.openai.com/docs/guides/rate-limits)). TPM and spend remain driven mainly by total text/audio tokens, not request count.

| Criterion | One request per sentence | Complete-message semantic chunks |
|---|---|---|
| Prosody | Every sentence resets model context; local prototype heard unnatural boundaries ([`NOTES.md`](../../NOTES.md)). | Preserves paragraph-level context within each bounded chunk. |
| Startup | First sentence can start before the assistant message finishes if sentence detection runs on deltas. | v0.1 intentionally waits for a complete message, matching existing accepted behavior ([`README.md`](../../README.md)). |
| Gaps | Each sentence adds request/first-byte latency unless prefetched. | Usually one request; only over-limit messages have inter-chunk request latency. |
| Rate limits | Multiplies RPM by average sentences per turn. | Approximately one request per short turn; bounded extra requests only for long turns. |
| Cost | Similar token-based nominal cost, but fresh prosody may alter output duration. Sequential sentences can avoid requesting unsent future sentences after cancellation. | A current chunk can be partly generated when cancelled; no undocumented refund is assumed. No prefetch bounds speculative/wasted work to the current chunk. |
| Cancellation granularity | Smaller future work units. | Current WAV stream can still be stopped immediately client-side; provider-side billing after disconnect is unknown. |
| Complexity | Needs robust sentence detection, queueing, prefetch, and ordering on partial Markdown. | Existing completion/sanitization path remains the source of truth. |

**Recommendation:** Split cleaned complete text in this order: paragraph boundary, sentence boundary, whitespace, then Unicode-scalar boundary, choosing the longest prefix whose UTF-8 byte length is at most 1,800. Never emit an empty chunk. Preserve exact order. Do not prefetch in v0.1; begin chunk `n+1` immediately after player `n` closes successfully. This favors deterministic cancellation and bounded cost over seamless playback for unusually long messages.

## Cancellation state machine and process semantics

### State model

Represent one active winner epoch and at most one active chunk:

| State | Owned resources | Allowed transition |
|---|---|---|
| `gagged` | none | `/talk` → `idle(talking)` |
| `idle(talking)` | winner epoch, pending chunks | start next → `fetching` or no chunks → remain idle |
| `fetching(epoch, chunk)` | one `AbortController`, response deadline timers | headers/current epoch → `playing`; winner/error → `cancelling` |
| `playing(epoch, chunk)` | controller, response reader/pipeline, one `ffplay` child, timers | pause → `paused`; close success → next `fetching`/`idle`; winner/error → `cancelling` |
| `paused(epoch, chunk)` | same resources; player stopped | `/unpause` → `playing`; explicit winner/gag/shutdown → `cancelling` |
| `cancelling(old epoch)` | old resources until settled | all old resources settled → state selected by new winner |

A **winner** is declared by:

1. `message_start` while mode is `talking`: the new assistant turn wins automatically.
2. `/talk`: the newest eligible complete message wins, including over paused audio.
3. `/gag` or session shutdown: silence wins and no replacement speech starts.

A new `message_start` while `paused` does **not** win automatically; pause preserves its exact position/backlog until `/unpause`, `/talk`, or `/gag`, matching the current documented UI contract ([`README.md`](../../README.md)).

### Exact newer-winner algorithm

**Recommendation:** Run these steps synchronously as one logical transition before launching replacement work:

1. Increment `winnerEpoch`; capture and clear old queue/resource references atomically. From this point, old callbacks may only clean up their own resources.
2. Close/destroy the old player's stdin so no additional stale bytes can be accepted.
3. Abort the old HTTP controller and cancel/destroy its response reader. Node's `AbortController` is a one-shot cancellation signal, and OpenAI's SDK also accepts an `AbortSignal` for requests ([Node `AbortController`](https://nodejs.org/api/globals.html#class-abortcontroller), [OpenAI request options](https://github.com/openai/openai-node/blob/master/src/internal/request-options.ts)).
4. If a player exists, send `SIGCONT` when it may be stopped, then `SIGTERM`. Wait for its `close` event for at most **250 ms**. Node documents that `subprocess.kill()` sends a signal but the process may not terminate, so the boolean/killed flag is not proof of exit ([Node child-process documentation](https://nodejs.org/api/child_process.html#subprocesskillsignal)).
5. If it has not closed, send `SIGKILL`; wait for `close` for up to **1 second**. Failure to observe close is an internal error and blocks launching another player until the old PID is confirmed absent.
6. Classify `AbortError`, response-reader cancellation, `EPIPE`, and signal-caused player close as expected only when their epoch is stale/cancelling. Never show them as user-facing TTS failures.
7. Before accepting headers, spawning a player, writing each response chunk, advancing the queue, or updating UI, compare the captured epoch with `winnerEpoch`. A mismatch discards the action.
8. Launch replacement fetch/playback only after the old player has closed or was confirmed absent. This guarantees at most one audible `ffplay` process.

Apple's `kill(2)` contract defines signals to a process and `waitpid(2)` distinguishes normal exit, signal termination, and stopped children; process termination must be observed rather than inferred from having sent a signal ([Apple `kill(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html), [Apple `waitpid(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html)).

### Provider-side cancellation uncertainty

**Documented client capability:** Aborting the signal cancels the client's fetch/request observation ([Node `AbortController`](https://nodejs.org/api/globals.html#class-abortcontroller), [OpenAI SDK request options](https://github.com/openai/openai-node/blob/master/src/internal/request-options.ts)).

**Unresolved/documentation absence:** The reviewed OpenAI Speech/API/model/pricing documents do not promise that disconnecting stops server synthesis immediately, nor do they specify partial-request billing or refunds. Therefore:

- abort is a client latency/privacy-control mechanism, not a cost-refund guarantee;
- no prefetched future chunk is allowed in v0.1;
- budget as if the entire submitted current chunk can be billed;
- do not automatically retry a request whose delivery status is ambiguous.

## Exact recommended v0.1 API/playback contract

### 1. Eligibility and text unit

1. Speak only assistant text and explicit structured question/option labels selected by existing product rules; never send thinking, tool output, fenced code, raw URLs, or secrets intentionally.
2. Wait for a non-aborted `message_end` before producing ordinary speech.
3. Apply the existing deterministic cleaning pass, trim, and skip an empty result ([`src/index.ts` lines 200–250](../../src/index.ts#L200-L250)).
4. Split the complete cleaned text with the semantic algorithm above, max **1,800 UTF-8 bytes per request**.
5. Queue chunks under the winning message/epoch. Concurrency is exactly **one Speech request and one player maximum**. No prefetch.

### 2. HTTP request

Send this exact body:

```json
{
  "model": "gpt-4o-mini-tts-2025-12-15",
  "voice": "marin",
  "input": "<one cleaned bounded chunk>",
  "response_format": "wav",
  "stream_format": "audio",
  "speed": 1.0
}
```

Use:

```http
POST /v1/audio/speech HTTP/1.1+
Authorization: Bearer <OPENAI_API_KEY>
Content-Type: application/json
Accept: audio/wav, application/octet-stream
```

The fields/models/formats are in OpenAI's generated Speech schema ([OpenAI SDK Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)). Pinning the snapshot avoids silent alias changes; changing snapshot, voice, format, or chunk policy is a reviewed contract change. Keep user speed local so changing speed does not issue another paid synthesis request; FFplay supports an audio filter graph through `-af` ([ffplay documentation](https://ffmpeg.org/ffplay.html#Main-options)).

### 3. Deadlines and retries

These are product recommendations, not provider SLAs:

- **15 s** from dispatch to response headers;
- **10 s** maximum idle time between response-body chunks, reset on every received chunk;
- **120 s** total wall-clock limit per chunk, including playback;
- all deadline expirations execute the same cancellation algorithm;
- **zero automatic retries** for 408, 429, 5xx, network reset, timeout, or ambiguous disconnect in v0.1;
- no retry for 400/input-too-long: treat it as a contract bug because pre-chunking should prevent it;
- expose `x-request-id` and rate-limit headers in redacted diagnostics, never the API key or spoken text. OpenAI documents request IDs and raw response-header access in its SDK ([OpenAI Node README](https://github.com/openai/openai-node#request-ids), [rate-limit headers](https://platform.openai.com/docs/guides/rate-limits#rate-limits-in-headers)).

The general OpenAI guidance suggests exponential backoff, but also says failed attempts consume rate-limit capacity ([rate-limit guide](https://platform.openai.com/docs/guides/rate-limits#retrying-with-exponential-backoff)). Interactive stale-speech risk outweighs transparent retry in v0.1; the user can explicitly invoke `/talk` again.

### 4. Response and player

After a successful status and non-empty body, verify the epoch, then spawn exactly:

```text
ffplay
  -nodisp
  -autoexit
  -hide_banner
  -loglevel error
  -f wav
  -af <validated atempo filter>
  -i pipe:0
```

`-f wav` forces the demuxer; `-nodisp`, `-af`, and `-autoexit` have documented ffplay meanings ([ffplay main options](https://ffmpeg.org/ffplay.html#Main-options), [advanced options](https://ffmpeg.org/ffplay.html#Advanced-options)). Pipe response bytes to stdin with backpressure. Do not buffer the complete WAV, write it to disk, or log it. Treat player exit code 0 after response EOF as success; a nonzero unsignalled exit is a playback error. Capture at most 2 KiB of player stderr for redacted diagnostics.

Do not require a strict `Content-Type`; OpenAI's generated client requests `application/octet-stream`, while the selected format is already fixed in the request ([OpenAI SDK Speech implementation](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)). Reject an HTML/JSON-looking successful body before playback if safely detectable, but rely primarily on HTTP status and ffplay decoding.

### 5. Queue completion

- Start chunk `n+1` only after chunk `n` has reached response EOF and its player has closed successfully.
- On any non-cancellation chunk failure, discard all remaining chunks for that message; do not skip ahead and speak out of context.
- Preserve the text UI regardless of speech failure.
- A speed change affects the next spawned player only, matching existing behavior.

## Error, privacy, and disclosure behavior

### User-visible errors

| Condition | v0.1 behavior |
|---|---|
| Missing API key | Stay gagged; show “Speech unavailable: `OPENAI_API_KEY` is not set.” Do not enqueue. |
| 401/403 | Stop current message; show one authentication/permission error; remain text-only. Do not display provider response body. |
| 400 | Stop current message; show “Speech request rejected.” Log status/request ID and a redacted error code only. Input-too-long is a contract-test failure. |
| 408/429 | Stop current message without retry; show “Speech temporarily unavailable (rate limited/timeout).” If present, include a bounded retry-after duration, not raw headers. |
| 5xx/network/deadline | Stop current message without retry; show one transient-unavailable notice. |
| `ffplay` missing/spawn failure | Stop and clear speech; show an actionable “Install FFmpeg or configure `PI_SPEAK_PLAYER`” error. |
| Decode/nonzero player exit | Stop remaining chunks; show “Speech playback failed”; keep bounded redacted stderr only in diagnostics. |
| Expected supersession/gag/shutdown cancellation | Silent; no error notification. |

Never interpolate raw provider bodies into notifications. They can echo customer input or operational detail. OpenAI warns that debug logging can contain sensitive request/response bodies ([OpenAI Node README logging warning](https://github.com/openai/openai-node#logging)).

### Privacy UX

Before the first `/talk` activation in each session, show:

> **AI voice:** Pi Talk sends the cleaned assistant text to OpenAI to generate speech. OpenAI may retain API content for up to 30 days for abuse monitoring unless your organization has approved data-retention controls. Audio is streamed to a local player and is not saved by Pi Talk.

Keep `AI voice · OpenAI` visible in the talking/paused status. Provide `/gag` as an immediate local stop and make talking opt-in on every session start. The training/retention wording follows OpenAI's data-control documentation: no training by default, up-to-30-day abuse-monitoring logs by default, no `/audio/speech` application-state retention, and ZDR eligibility only for approved organizations ([OpenAI data controls](https://platform.openai.com/docs/guides/your-data)).

Do not log:

- `Authorization` or the API key;
- cleaned or original spoken text;
- response audio bytes;
- raw provider error body;
- environment dumps.

Permitted diagnostics: timestamp, winner epoch/chunk index, byte/character counts, model snapshot, voice, HTTP status, OpenAI request ID, redacted rate-limit counters, timing metrics, ffplay PID/exit status, and bounded sanitized stderr.

### AI-voice disclosure

The pre-activation notice and persistent `AI voice` status are mandatory, not optional settings, because OpenAI requires clear end-user disclosure that the voice is AI-generated and not human ([speech guide](https://platform.openai.com/docs/guides/text-to-speech)). If no UI exists, the command must print the notice to the active output channel before audio begins.

## Test and verification criteria

Production implementation does not satisfy this contract until all criteria pass.

### Deterministic automated tests

1. **Request fixture:** Assert exact URL, method, snapshot, voice, WAV/audio formats, API speed, headers, and absence of raw text in logs.
2. **Chunk bounds:** Property-test ASCII, multi-byte Unicode, long words, paragraphs, abbreviations, and empty-after-cleaning input. Every chunk is non-empty, ordered/lossless modulo inserted joining whitespace, at most 1,800 UTF-8 bytes, and no message uses sentence-per-request unless each semantic chunk independently reaches the cap.
3. **Completion gate:** No ordinary Speech request occurs before a non-aborted `message_end`.
4. **Streaming:** A fake chunked server sends a valid WAV header/audio in delayed pieces. Assert player spawn after headers, bytes reach stdin before response EOF, and pipeline backpressure is respected.
5. **Winner before headers:** New epoch aborts fetch; a late old response cannot spawn a player or update current UI.
6. **Winner during playback:** Old stdin closes, request/reader aborts, player receives bounded termination, and replacement player starts only after old close.
7. **Winner while paused:** `/talk` and `/gag` terminate the stopped player without audible stale continuation; an automatic `message_start` alone preserves paused state by contract.
8. **Signal escalation:** Fake player ignores `SIGTERM`; `SIGKILL` occurs after 250 ms and failure is raised if close is not observed within the following second.
9. **Expected cancellation noise:** `AbortError`, `EPIPE`, and signalled close from stale epochs produce no user error. The same errors in the current epoch follow the failure table.
10. **Queue failure:** Any current-chunk HTTP/decode failure discards later chunks; no out-of-context continuation occurs.
11. **No retry:** 408, 429, 5xx, reset, timeout, and ambiguous disconnect each cause exactly one provider request.
12. **Timeouts:** Header, body-idle, and total timers independently trigger the same idempotent cancellation path and leave no active timers/resources.
13. **Disclosure:** No first audio byte is written before the session disclosure is rendered; talking/paused status includes `AI voice`.
14. **Privacy:** Snapshot diagnostics under success and every error contain no API key, original/cleaned text, audio bytes, raw error body, or environment values.
15. **Lifecycle:** After 100 randomized start/pause/unpause/supersede/gag/shutdown races, there is at most one player at any instant, no child remains, queue/controller/player references are empty, and no unhandled rejection occurs.

### macOS integration tests

Run against the minimum supported macOS and packaged FFmpeg version:

1. `ffplay -version`, `ffplay -formats`, and `ffplay -decoders` confirm the expected WAV demuxer/PCM decoder before enabling speech ([ffplay generic options](https://ffmpeg.org/ffplay.html#Generic-options)).
2. A local streamed WAV fixture begins playing before fixture EOF and exits 0 after EOF.
3. Pause/unpause resumes from the same audible position.
4. Supersession while playing and paused stops stale audio within **250 ms** in 20/20 trials and leaves no `ffplay` process.
5. `SIGTERM` escalation test leaves no zombie/orphan process.
6. Playback at supported min/default/max local speeds is intelligible and preserves expected pitch; rates above a single filter's quality range use the repository's validated filter chain.

### Gated live OpenAI smoke tests

These tests incur cost and require explicit opt-in:

1. The exact pinned snapshot and `marin` return a playable streamed WAV.
2. First audio bytes arrive before HTTP EOF.
3. Warm request-to-first-audible latency is recorded; target **p95 ≤ 2.5 s** over 20 short English chunks. Cold target is **≤ 5 s**. These are product acceptance targets, not OpenAI SLAs.
4. Cancelling before headers and during audio makes local playback silent within 250 ms. Record whether request IDs/usage appear in account reporting; do not infer a refund.
5. A 1,800-byte chunk succeeds; multilingual and pathological-token inputs remain below published limits or fail closed without retry.
6. Capture rate-limit headers to confirm the account's actual limits; do not assert Tier-1 values if the project is on another tier.
7. Confirm no WAV/temp file appears in the repository, temp directory, or configured logs.

## Unresolved risks and explicit non-contracts

1. **Provider abort/billing:** OpenAI does not document whether disconnect stops synthesis immediately or how a partial Speech stream is billed. Budget full submitted chunks.
2. **Tokenizer coupling:** The 1,800-byte cap relies on OpenAI's current GPT-4o prefix-to-`o200k_base` mapping and BPE byte property; Speech-specific tokenization is not separately promised. Live pathological-input verification is required.
3. **Voice-count documentation drift:** The guide says 11 in one place and enumerates 13 elsewhere. `marin` is present in both the detailed guide/schema and must be smoke-tested.
4. **Model lifecycle:** The pinned `2025-12-15` snapshot can eventually be deprecated. Fail clearly rather than silently falling back or changing models.
5. **No latency SLA:** Streaming availability is documented, but first-byte latency and chunk cadence are not. The acceptance thresholds are product targets.
6. **WAV stream details:** OpenAI does not publish exact WAV sample rate/channel/header-length behavior as a stable contract. Force the WAV demuxer and test fixtures/live output; do not parse fixed byte offsets in application code.
7. **Raw PCM channel count:** OpenAI documents sample rate/bit depth/endianness but not channels. PCM cannot replace WAV without a first-party clarification or a pinned live verification.
8. **Long-message gaps:** Sequential no-prefetch chunking can produce audible gaps. If tests reject them, a later contract may add one-ahead prefetch, which requires multiple controllers, bounded in-memory audio, cancellation of both current/future work, and an explicit wasted-cost budget.
9. **`ffplay` as production dependency:** FFplay describes itself as a simple testbed ([ffplay description](https://ffmpeg.org/ffplay.html#Description)). v0.1 accepts that dependency; a native AVFAudio/Audio Queue backend is the production-hardening path.
10. **Regional/data controls:** Retention and residency depend on organization approval/project configuration. UI must not claim ZDR merely because the endpoint is eligible ([OpenAI data controls](https://platform.openai.com/docs/guides/your-data)).

## Source list

All external sources are first-party and were accessed 2026-07-18.

### OpenAI

- [Text to speech guide](https://platform.openai.com/docs/guides/text-to-speech)
- [Audio and speech concepts](https://platform.openai.com/docs/guides/audio)
- [GPT-4o mini TTS model and rate limits](https://platform.openai.com/docs/models/gpt-4o-mini-tts)
- [TTS-1 model](https://platform.openai.com/docs/models/tts-1)
- [TTS-1 HD model](https://platform.openai.com/docs/models/tts-1-hd)
- [API pricing](https://platform.openai.com/docs/pricing)
- [Rate-limit guide](https://platform.openai.com/docs/guides/rate-limits)
- [Data controls](https://platform.openai.com/docs/guides/your-data)
- [Generated OpenAI Node Speech schema](https://github.com/openai/openai-node/blob/master/src/resources/audio/speech.ts)
- [Generated OpenAI Node request options](https://github.com/openai/openai-node/blob/master/src/internal/request-options.ts)
- [OpenAI Node README](https://github.com/openai/openai-node)
- [OpenAI `tiktoken` model mapping](https://github.com/openai/tiktoken/blob/main/tiktoken/model.py)
- [OpenAI `tiktoken` README](https://github.com/openai/tiktoken)

### FFmpeg

- [ffplay documentation](https://ffmpeg.org/ffplay.html)
- [FFmpeg format documentation](https://ffmpeg.org/ffmpeg-formats.html)
- [FFmpeg pipe protocol](https://ffmpeg.org/ffmpeg-protocols.html#pipe)
- [FFmpeg audio-filter documentation](https://ffmpeg.org/ffmpeg-filters.html#Audio-Filters)

### Apple and Node.js runtime

- [Apple Audio Queue Services Programming Guide](https://developer.apple.com/library/archive/documentation/MusicAudio/Conceptual/AudioQueueProgrammingGuide/Introduction/Introduction.html)
- [Apple `kill(2)` manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/kill.2.html)
- [Apple `waitpid(2)` manual](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/waitpid.2.html)
- [Node.js `AbortController`](https://nodejs.org/api/globals.html#class-abortcontroller)
- [Node.js child-process signals](https://nodejs.org/api/child_process.html#subprocesskillsignal)

### Repository evidence

- [`src/index.ts`](../../src/index.ts)
- [`README.md`](../../README.md)
- [`NOTES.md`](../../NOTES.md)
