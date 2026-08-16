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

type PluginSettings = {
    enabled: boolean;
    cliPath: string;
    heartbeatIntervalSeconds: number;
    trackCursorMovement: boolean;
    trackEdits: boolean;
    trackBufferActivation: boolean;
    excludePathRegex: string;
    dryRun: boolean;
    debug: boolean;
};

type FreshActivityEvent = {
    buffer_id?: number;
    bufferId?: number;
    path?: string;
    line?: number;
};

type ActivityType =
    | "buffer-activated"
    | "edit"
    | "cursor"
    | "save";

// state

let lastHeartbeatFile: string | null = null;
let lastHeartbeatTime = 0;

let heartbeatInProgress = false;

// read the config

function getPluginSettings(): PluginSettings {
    const config = 
        (editor.getPluginConfig() ?? {}) as Partial<PluginSettings>;
    
    return {
        enabled: config.enabled !== false,

        cliPath:
            typeof config.cliPath === "string" &&
            config.cliPath.trim() !== ""
                ? config.cliPath.trim()
                : "wakatime-cli",
            
        heartbeatIntervalSeconds:
            typeof config.heartbeatIntervalSeconds === "number" &&
                ? config.heartbeatIntervalSeconds
                : DEFAULT_HEARTBEAT_INTERVAL,

        trackCursorMovement:
            config.trackCursorMovement !== false,
        
        trackEdits:
            config.trackEdits !== false,

        trackBufferActivation:
            config.trackBufferActivation !== false,
        
        excludePathRegex:
            typeof config.excludePathRegex === "string" 
            ? config.excludePathRegex
            : DEFAULT_EXCLUDE_REGEX,
        
        dryRun:
            config.dryRun === true,
        
        debug:
            config.debug === true,
    };
}

//logging

function debug(message: string):void {
    if (!getPluginSettings().debug) {
        return;
    }
    
    editor.debug(`[${PLUGIN_NAME}] ${message}`);
}

// find the file associated with an event
