# Prototype Findings

## Question

Do whole-response playback and the locked `/talk`, `/pause`, `/unpause`, and `/gag` semantics feel correct during real Pi grilling sessions?

## Verdict

Validated for the v0.1 specification. Prioritize one OpenAI request per complete assistant response: it sounded substantially more natural than separate sentence requests. Keep semantic 2–3 sentence chunks with one-ahead prefetch as a future option if completion delay becomes a problem.

Use `/talk`, `/pause`, `/unpause`, and `/gag`. Preserve inline code text while suppressing fenced code. Common delimited LaTeX filtering is best effort and non-blocking for v0.1.

## Confirmed

- OpenAI `gpt-4o-mini-tts` returned streamed WAV successfully.
- `ffplay` completed successfully and Stanley clearly heard the `marin` voice diagnostic.
- `/talk`, `/gag`, and `/pause` worked during the first live pass.
- `/resume` conflicted with Pi's built-in command, so the prototype renamed the speech action to `/unpause`.
- After restart, `/pause` → `/unpause` continued from the exact playback position without a command conflict.
- `/talk` discarded paused old audio and started the newer message from its beginning.
- A structured `ask_user_question` was spoken exactly once with concise option labels and no descriptions.
- Prose before and after a fenced JavaScript block was spoken while the code remained silent.
- Separate sentence requests sounded slow and unnatural. Measured response waits were about 4.2 s cold, then 1.0 s and 0.37 s between sentences.
- A whole-paragraph request sounded substantially more natural and seamless.
- Two prefetched semantic chunks had no measured inter-chunk wait and sounded close to the whole paragraph, so chunking remains a future option while whole-response playback is prioritized.

## Observe

- Time from message completion until speech begins: acceptable in the first live pass.
- Whether whole-response prosody sounds natural: yes.
- Whether question options are concise enough: yes; labels played once and descriptions stayed silent.
- Whether a newer assistant message interrupts stale speech while Talking: yes.
- Whether `/pause` and `/unpause` preserve the exact playback position: yes.
- Whether `/talk` during stale or paused audio starts the newest message from its beginning: yes.
- Whether `/gag` stops immediately and prevents automatic speech: yes in the first live pass.
- Whether fenced code or Markdown leaks into speech: tested fenced code stayed silent.
- Whether inline code remains understandable when spoken: yes.
- Preferred voice and speed: not decided; tests used the default `marin` voice.
- Any duplicate, skipped, or out-of-order speech: none observed.
- LaTeX edge case: removing a list of equations left orphan commas that were spoken; punctuation cleanup was added, but deeper LaTeX handling is intentionally out of scope.

## Playback-speed control

### Decision under test

Pi exposes keyboard-driven custom TUI components but no documented native slider or mouse/drag event API. `/speed` therefore opens a keyboard slider: `j` speeds up, `k` slows down, shifted `j`/`k` make fine changes, arrows remain optional coarse controls, Space pauses/unpauses playback in place, `r` resets, Enter applies, and Escape or Ctrl+C cancels. `/speed <rate>` remains available for direct control and non-TUI modes.

The prototype defaults to `1.25×`, limits speed to `0.50×–3.00×`, applies changes to the next utterance through `ffplay -af atempo=…`, and uses a valid `PI_TALK_SPEED` only as the startup override. Invalid values fall back to the default. Rates above `2.00×` chain two tempo factors so no individual `atempo` filter exceeds `2.00×`. UI changes are intentionally in-memory until package configuration is designed.

### Cross-review

An independent 5.6-sol reviewer at xhigh found no blockers. Its verified findings led to strict environment parsing, a TUI-mode slider guard, configurable Pi confirm/cancel bindings, and chained tempo filters above `2.00×`.

### Observe

- Whether the slider opens and renders correctly at normal and narrow terminal widths: normal-width rendering passed.
- Whether coarse (`0.10×`) and fine (`0.05×`) keyboard changes feel right: controls, reset, apply, and footer status passed.
- Whether `1.50×` is noticeably faster without pitch distortion: passed for the diagnostic and a regular response.
- Whether changing speed leaves active audio untouched and affects the next utterance: next-utterance speed change passed.
- Preferred default, minimum, maximum, and step sizes: `1.25×` default; `0.50×–3.00×`; `0.10×` coarse and `0.05×` fine steps. Final mapping is `j` faster, `k` slower, with shifted keys for fine changes; `3.00×` passed live playback.
- Whether Space in the slider pauses and unpauses without closing it: passed; exact-position audio and rendered state both updated.
