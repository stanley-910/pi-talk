import assert from "node:assert/strict";
import test from "node:test";
import { cleanForSpeech, cleanMarkdownForSpeech, stripFencedCode } from "../src/clean.ts";

test("stripFencedCode drops fenced blocks and keeps the prose around them", () => {
  const markdown = [
    "Here is the fix.",
    "```typescript",
    "async function teardown() {",
    "  await player.kill();",
    "}",
    "```",
    "That is all.",
  ].join("\n");

  assert.equal(stripFencedCode(markdown), "Here is the fix.\nThat is all.");
});

test("stripFencedCode handles tilde fences, long fences, and indentation", () => {
  assert.equal(stripFencedCode(["A", "~~~", "code", "~~~", "B"].join("\n")), "A\nB");
  assert.equal(
    stripFencedCode(["A", "````", "```", "still code", "````", "B"].join("\n")),
    "A\nB",
  );
  assert.equal(stripFencedCode(["A", "   ```", "code", "   ```", "B"].join("\n")), "A\nB");
  // Four spaces is an indented code block, not a fence, so it never opens one.
  assert.equal(stripFencedCode(["A", "    ```", "B"].join("\n")), "A\n    ```\nB");
});

test("an unterminated fence swallows the rest of the message", () => {
  assert.equal(stripFencedCode(["Prose.", "```", "code", "more code"].join("\n")), "Prose.");
});

test("cleanForSpeech speaks inline code but not its backticks", () => {
  assert.equal(cleanForSpeech("Call `teardown()` first."), "Call teardown() first.");
});

test("cleanForSpeech removes math, link targets, URLs, and markdown syntax", () => {
  assert.equal(cleanForSpeech("Alpha. \\(x + y\\) Omega."), "Alpha. Omega.");
  assert.equal(cleanForSpeech("See $$a + b$$ here."), "See here.");
  assert.equal(cleanForSpeech("Read [the docs](https://example.com/page) now."), "Read the docs now.");
  assert.equal(cleanForSpeech("Go to https://example.com/page for more."), "Go to for more.");
  assert.equal(cleanForSpeech("## Heading"), "Heading");
  assert.equal(cleanForSpeech("- first\n- second"), "first second");
  assert.equal(cleanForSpeech("This is **bold** and _thin_."), "This is bold and thin.");
});

test("cleanMarkdownForSpeech runs fences out then prose cleaning", () => {
  const markdown = [
    "Here is the **fix** for `teardown()`:",
    "```ts",
    "await player.kill();",
    "```",
    "Details at https://example.com/x for the rest.",
  ].join("\n");

  assert.equal(
    cleanMarkdownForSpeech(markdown),
    "Here is the fix for teardown(): Details at for the rest.",
  );
});

test("cleanMarkdownForSpeech applies math stripping exactly once", () => {
  // A second stripDelimitedMath pass would eat the surviving `$5 and $6`.
  assert.equal(cleanMarkdownForSpeech("It costs $5 and $6 total."), "It costs $5 and $6 total.");
});
