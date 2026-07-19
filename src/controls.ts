export const MIN_PLAYBACK_SPEED = 0.5;
export const MAX_PLAYBACK_SPEED = 3;
export const DEFAULT_PLAYBACK_SPEED = 1.25;
export const COARSE_SPEED_STEP = 0.1;
export const FINE_SPEED_STEP = 0.05;
export const PRIMARY_SHORTCUT = "ctrl+shift+space";
export const SPEED_UP_SHORTCUT = "ctrl+shift+.";
export const SPEED_DOWN_SHORTCUT = "ctrl+shift+,";

export type SpeechMode = "gagged" | "talking" | "paused";
export type PrimaryShortcutAction = "talk" | "pause" | "unpause";

type ShortcutOptions<Context> = {
  description?: string;
  handler: (context: Context) => Promise<void> | void;
};

type PiTalkShortcut = typeof PRIMARY_SHORTCUT | typeof SPEED_UP_SHORTCUT | typeof SPEED_DOWN_SHORTCUT;

type ShortcutRegistry<Context> = {
  registerShortcut(shortcut: PiTalkShortcut, options: ShortcutOptions<Context>): void;
};

type ShortcutActions<Context> = {
  activate(context: Context): Promise<void> | void;
  adjustSpeed(context: Context, delta: number): Promise<void> | void;
};

export function clampPlaybackSpeed(speed: number): number {
  return Math.round(Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, speed)) * 100) / 100;
}

export function primaryShortcutAction(mode: SpeechMode): PrimaryShortcutAction {
  if (mode === "gagged") return "talk";
  return mode === "talking" ? "pause" : "unpause";
}

export function registerPiTalkShortcuts<Context>(
  pi: ShortcutRegistry<Context>,
  actions: ShortcutActions<Context>,
): void {
  pi.registerShortcut(PRIMARY_SHORTCUT, {
    description: "Talk, pause, or unpause Pi Talk",
    handler: (context) => actions.activate(context),
  });
  pi.registerShortcut(SPEED_UP_SHORTCUT, {
    description: "Increase Pi Talk playback speed",
    handler: (context) => actions.adjustSpeed(context, COARSE_SPEED_STEP),
  });
  pi.registerShortcut(SPEED_DOWN_SHORTCUT, {
    description: "Decrease Pi Talk playback speed",
    handler: (context) => actions.adjustSpeed(context, -COARSE_SPEED_STEP),
  });
}
