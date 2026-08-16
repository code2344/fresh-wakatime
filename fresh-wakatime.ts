const editor = getEditor();

const PLUGIN_NAME = "fresh-wakatime";
const PLUGIN_VERSION = "0.1.0";

const DEFAULT_HEARTBEAT_INTERVAL = 120; // seconds

// exclude the project name of this project so i don't fraud
const DEFAULT_EXCLUDE_REGEX =
  String.raw`(^|[\\/])fresh-wakatime([\\/]|$)`;


// configuration for the plugin

editor.defineConfigBoolean("enabled", {
    default: true,
    description: "Enable WakaTime time tracking.",
});

editor.defineConfigString("cliPath", {
  default: "wakatime-cli",
  description: "Path to the wakatime-cli executable.",
});

editor.defineConfigInteger("heartbeatIntervalSeconds", {
    default: DEFAULT_HEARTBEAT_INTERVAL,
    minimum: 30,
    maximum: 3600,
    description: "Minimum time between normal heartbeats.",
});

editor.defineConfigString("trackCursorMovement", {
    default: true,
    description: "Send heartbeats on cursor movement.",
});

editor.defineConfigBoolean("trackEdits", {
    default: true,
    description: "Send heartbeats on edits.",
});

editor.defineConfigBoolean("trackBufferActivation", {
    default: true,
    description: "Send heartbeats when switching files.",
});

editor.defineConfigString("excludePathRegex", {
  default: DEFAULT_EXCLUDE_REGEX,
  description: "Paths matching this regex are never passed to wakatime-cli.",
});

editor.defineConfigBoolean("dryRun", {
    default: false,
    description: "Process events normally but don't launch wakatime cli (for debugging)"
});

editor.defineConfigBoolean("debug", {
    default: false,
    description: "Print debug messages to the console.",
});

