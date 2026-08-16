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
            typeof config.heartbeatIntervalSeconds === "number"
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

function getBufferId(event?: FreshActivityEvent): number {
    if (
        event &&
        typeof event.buffer_id === "number"
    ) {
        return event.buffer_id;
    }

    if (
        event &&
        typeof event.bufferId === "number"
    ) {
        return event.bufferId;
    }

    return editor.getActiveBufferId();
}

function getFilePath(
    event?: FreshActivityEvent,
): string | null {
    // buffer_save ggives us a direct actual path
    if (
        event &&
        typeof event.path === "string" &&
        event.path.trim() !== ""
    ) {
        return event.path.trim();
    }

    const bufferId = getBufferId(event);

    if (bufferId === null) {
        return null;
    }

    const path = editor.getBufferPath(bufferId);

    if (!path || path.trim() === "") {
        return null;
    }

    return path;
}

// current line

function getLineNumber(
  event?: FreshActivityEvent,
): number | null {
  if (
    event &&
    typeof event.line === "number" &&
    event.line > 0
  ) {
    return Math.floor(event.line);
  }

  try {
    const line = editor.getCursorLine();

    if (line > 0) {
      return Math.floor(line);
    }
  } catch (_error) {
    // some buffers don't have normal cursor
  }

  return null;
}

// exclusion checking so i don't fabricate heartbeats for this project

function isExcluded(
    filePath: string,
    regexText: string,
): boolean {
    if (regexText.trim() === "") {
        return false;
    }

    try {
        const regex = new RegExp(regexText);
        return regex.test(filePath);
    } catch (error) {
        // i'd rather track nothing than accidentally track everything if there's  a typo in the exclusion path/regex
        editor.warn(
          `[${PLUGIN_NAME}] Invalid excludePathRegex: ${String(error)}`,
        );
        return true;
    }
}


// throttling

function shouldSendHeartbeat(
    filePath: string,
    isWrite: boolean,
    intervalSeconds: number,
): boolean {
    if (isWrite) {
        return true;
    }

    // first heartbeat
    if (lastHeartbeatFile === null) {
        return true;
    }

    // different file
    if (filePath !== lastHeartbeatFile) {
        return true;
    }

    const elapsed = Date.now() - lastHeartbeatTime;

    return (
        elapsed >= intervalSeconds * 1000
    )
}

// build wakatime-cli command args

function buildHeartbeatArgs(
    filePath: string,
    lineNumber: number | null,
    isWrite: boolean,
): string[] {
    const args = [
        "--entity",
        filePath,

        "--plugin",
        `${PLUGIN_NAME}/${PLUGIN_VERSION}`,
    ];

    if (lineNumber !== null) {
        args.push("--lineno", String(lineNumber));
    }

    if (isWrite) {
        args.push("--write");
    }
    
    return args;
}

// now send this heartbeat

async function sendHeartbeat(
    event: FreshActivityEvent | undefined,
    isWrite: boolean,
    activityType: ActivityType,
): Promise<void> {
    const settings = getPluginSettings();

    // is tracking enabled?
    if (!settings.enabled) {
        debug(`ignored ${activityType} event because tracking is disabled`);
        return;
    }

    const filePath = getFilePath(event);

    if (filePath === null) {
        debug(`ignored ${activityType} event because no file path could be determined`);
        return;
    }

    if (isExcluded(filePath, settings.excludePathRegex)) {
        debug(`ignored ${activityType} event for excluded file path: ${filePath}`);
        return;
    }

    if (
        !shouldSendHeartbeat(
            filePath,
            isWrite,
            settings.heartbeatIntervalSeconds,
        )
    ) {
        debug(`ignored ${activityType} event for file path: ${filePath} because of throttling`);
        return;
    }

    // avoid simultaneous heartbeats
    if (
        heartbeatInProgress &&
        !isWrite
    ) {
        debug(
            `ignored ${activityType}: heartbeat already running`,
        );

        return;
    }

    heartbeatInProgress = true;

    try {
        const lineNumber = event?.line ?? null;
        const args = buildHeartbeatArgs(filePath, lineNumber, isWrite);

        if (settings.dryRun) {
            debug(`dry run: ${settings.cliPath} ${args.join(" ")}`);
            return;
        }

        await runCommand(settings.cliPath, args);

        lastHeartbeatFile = filePath;
        lastHeartbeatTime = Date.now();

        debug(`sent ${activityType} heartbeat for file: ${filePath}`);
    } finally {
        heartbeatInProgress = false;
    }
}


// fresh event handlers