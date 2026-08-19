const editor = getEditor();

const PLUGIN_NAME = "fresh-wakatime";
const PLUGIN_VERSION = "0.1.0";

const DEFAULT_HEARTBEAT_INTERVAL = 120; // seconds

// exclude the project name of this project so i don't fraud
const DEFAULT_EXCLUDE_REGEX =
  String.raw`(^|[\\/])fresh-wakatime([\\/]|$)|[\\/]Library[\\/]Application Support[\\/]fresh[\\/]terminals[\\/]`;


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

editor.defineConfigBoolean("trackCursorMovement", {
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

    if (bufferId === 0) {
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

    if (settings.dryRun) {
        editor.info(
            `[${PLUGIN_NAME}] dry-run: ` +
            `${settings.cliPath} ` +
            JSON.stringify(
                buildHeartbeatArgs(
                    filePath,
                    getLineNumber(event),
                    isWrite,
                ),
            ),
        );
        return;
    }

    heartbeatInProgress = true;

    try {
                const args = buildHeartbeatArgs(
                        filePath,
                        getLineNumber(event),
                        isWrite,
                );

                const result = await editor.spawnProcess(
                        settings.cliPath,
                        args,
                );

                if (result.exit_code !== 0) {
                        editor.warn(
                                `[${PLUGIN_NAME}] wakatime-cli failed: ` +
                                result.stderr.trim(),
                        );

                        return;
                }

                // Only update throttling state after a successful CLI invocation.
                lastHeartbeatFile = filePath;

                lastHeartbeatTime = Date.now();

                debug(
                        `sent ${activityType} heartbeat: ${filePath}`,
                );
        } catch (error) {
                editor.warn(
                        `[${PLUGIN_NAME}] could not run wakatime-cli: ` +
                        String(error),
                );
        } finally {
                heartbeatInProgress = false;
        }
}


// fresh event handlers

(globalThis as any).fresh_wakatime_buffer_activated = async function(
    event: FreshActivityEvent | undefined,
): Promise<void> {
    if (!getPluginSettings().trackBufferActivation) {
        return;
    }

    await sendHeartbeat(
        event,
        false,
        "buffer-activated",
    );
};

(globalThis as any).fresh_wakatime_after_insert = async function(
    event: FreshActivityEvent | undefined,
): Promise<void> {
    if (!getPluginSettings().trackEdits) {
        return;
    }

    await sendHeartbeat(
        event,
        false,
        "edit",
    );
};

(globalThis as any).fresh_wakatime_after_delete = async function(
    event: FreshActivityEvent | undefined,
): Promise<void> {
    if (!getPluginSettings().trackEdits) {
        return;
    }

    await sendHeartbeat(
        event,
        false,
        "edit",
    );
};

(globalThis as any).fresh_wakatime_cursor_moved = async function(
    event: FreshActivityEvent | undefined,
): Promise<void> {
    if (!getPluginSettings().trackCursorMovement) {
        return;
    }

    await sendHeartbeat(
        event,
        false,
        "cursor",
    );
};

(globalThis as any).fresh_wakatime_buffer_save = async function(
    event: FreshActivityEvent | undefined,
): Promise<void> {
    await sendHeartbeat(
        event,
        true,
        "save",
    );
};

// subscribe to fresh events

editor.on(
    "buffer_activated",
    "fresh_wakatime_buffer_activated",
);

editor.on(
    "after_insert",
    "fresh_wakatime_after_insert",
);

editor.on(
    "after_delete",
    "fresh_wakatime_after_delete",
);

editor.on(
    "cursor_moved",
    "fresh_wakatime_cursor_moved",
);

editor.on(
    "after_file_save",
    "fresh_wakatime_buffer_save",
);

//safe commands

(globalThis as any).fresh_wakatime_status = function(): void {
        const settings = getPluginSettings();

        const filePath = getFilePath();

        let fileStatus = "no active file";

        if (filePath !== null) {
                if (
                        isExcluded(
                                filePath,
                                settings.excludePathRegex,
                        )
                ) {
                        fileStatus = `current file excluded: ${filePath}`;
                } else {
                        fileStatus = `current file trackable: ${filePath}`;
                }
        }

        const statusText =
                `WakaTime: ` +
                `${settings.enabled ? "enabled" : "disabled"}` +
                `${settings.dryRun ? " | dry-run" : ""}` +
                ` | ${fileStatus}`;

        editor.setStatus(statusText);
};

(globalThis as any).fresh_wakatime_check_cli = async function(): Promise<void> {
        const settings = getPluginSettings();

        try {
                // --version does not send a heartbeat.
                const result = await editor.spawnProcess(
                        settings.cliPath,
                        ["--version"],
                );

                if (result.exit_code === 0) {
                        editor.setStatus(
                                `WakaTime CLI: ${result.stdout.trim()}`,
                        );
                } else {
                        editor.setStatus(
                                `WakaTime CLI failed with exit code ${result.exit_code}`,
                        );
                }
        } catch (error) {
                editor.setStatus(
                        `WakaTime CLI unavailable: ${String(error)}`,
                );
        }
};

(globalThis as any).fresh_wakatime_check_exclusion = function(): void {
        const settings = getPluginSettings();

        const filePath = getFilePath();

        if (filePath === null) {
                editor.setStatus(
                        "WakaTime: no active file",
                );

                return;
        }

        if (
                isExcluded(
                        filePath,
                        settings.excludePathRegex,
                )
        ) {
                editor.setStatus(
                        `WakaTime BLOCKED: ${filePath}`,
                );
        } else {
                editor.setStatus(
                        `WakaTime allowed: ${filePath}`,
                );
        }
};

editor.registerCommand(
  "WakaTime: Status",
  "Show WakaTime plugin status",
  "fresh_wakatime_status",
);

editor.registerCommand(
  "WakaTime: Check CLI",
  "Check wakatime-cli without sending a heartbeat",
  "fresh_wakatime_check_cli",
);

editor.registerCommand(
  "WakaTime: Check Current File Exclusion",
  "Check whether the current file can be tracked",
  "fresh_wakatime_check_exclusion",
);

debug(
  "plugin loaded; no heartbeat sent on startup",
);
