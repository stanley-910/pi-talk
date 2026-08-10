// Markdown-to-speech cleaning, shared by the Pi extension (src/index.ts) and the
// standalone speaker CLI (src/speaker.ts) so both paths speak the same text.
//
// The contract: fenced code is silent, inline code inside prose is spoken.
import { stripDelimitedMath } from "./speech.ts";

/**
 * Drops fenced code blocks and keeps the prose around them. Fences may open
 * with three or more backticks or tildes, indented by at most three spaces, and
 * only a run of the same marker that is at least as long closes them.
 */
export function stripFencedCode(markdown: string): string {
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

/**
 * Turns prose markdown into speakable text: math, link targets, URLs, and
 * markdown punctuation go away while the words survive. Applies
 * `stripDelimitedMath` itself, so callers must not apply it again.
 */
export function cleanForSpeech(text: string): string {
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

/** The whole pipeline the Pi extension runs: fences out, then prose cleaned. */
export function cleanMarkdownForSpeech(markdown: string): string {
  return cleanForSpeech(stripFencedCode(markdown));
}
