import { app, BrowserWindow } from "electron";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { setupAutoUpdaterHandlers, startUpdateLoop } from "./core/updater.cjs";
import { checkSettingsAndStart } from "./core/windows.cjs";
import { createMenu } from "./core/menu.cjs";
import { setupSystemIPC } from "./ipc/system.cjs";
import { setupSnapshotsIPC } from "./ipc/snapshots.cjs";
import { setupAssetsIPC } from "./ipc/assets.cjs";
import { setupTasksIPC } from "./ipc/tasks.cjs";
import { setupDefaultCommentsIPC } from "./ipc/default-comments.cjs";

import { appState } from "./core/state.cjs";

if (ffmpegStatic) {
    // In production the binary lives in the unpacked directory alongside the .asar,
    // not inside it (binaries cannot be spawned from within an .asar archive).
    const ffmpegPath = ffmpegStatic.replace(
        'app.asar',
        'app.asar.unpacked'
    );
    ffmpeg.setFfmpegPath(ffmpegPath);
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (appState.mainWindow) {
            if (appState.mainWindow.isMinimized()) appState.mainWindow.restore();
            if (!appState.mainWindow.isVisible()) appState.mainWindow.show();
            appState.mainWindow.focus();
        } else if (appState.settingsWindow) {
            if (appState.settingsWindow.isMinimized()) appState.settingsWindow.restore();
            if (!appState.settingsWindow.isVisible()) appState.settingsWindow.show();
            appState.settingsWindow.focus();
        }
    });

    // --- Forward Main Process Logs to DevTools ---
    const originalLog = console.log;
    const originalError = console.error;

    function forwardToDevTools(type: 'log' | 'error', ...args: any[]) {
        if (appState.mainWindow && !appState.mainWindow.isDestroyed()) {
            try {
                const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
                const safeMsg = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
                appState.mainWindow.webContents.executeJavaScript(`console.${type}("[Main Process] ${safeMsg}")`).catch(() => { });
            } catch (e) { }
        }
    }

    console.log = (...args) => {
        originalLog(...args);
        forwardToDevTools('log', ...args);
    };

    console.error = (...args) => {
        originalError(...args);
        forwardToDevTools('error', ...args);
    };

    // Create myWindow, load the rest of the app, etc...
    app.whenReady().then(() => {
        setupSystemIPC();
        setupSnapshotsIPC();
        setupAssetsIPC();
        setupTasksIPC();
        setupDefaultCommentsIPC();

        createMenu();

        // Setup interactive update handlers
        setupAutoUpdaterHandlers();
        startUpdateLoop();

        checkSettingsAndStart();
    });
}

app.on("window-all-closed", () => {
    // keeping app active in background (macOS style) is effectively what we are doing with tray minimize
    // but on Windows usually it quits if all windows closed. However, we are intercepting close.
    // So this might not even be hit unless we force quite.
    if (process.platform !== "darwin") app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        checkSettingsAndStart();
    }
});
