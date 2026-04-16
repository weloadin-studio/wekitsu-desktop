import { BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import path from "path";
import { appState } from "./state.cjs";

export function createUpdateProgressWindow() {
    if (appState.updateProgressWindow) return;

    appState.updateProgressWindow = new BrowserWindow({
        width: 400,
        height: 120,
        frame: false,
        parent: appState.mainWindow || appState.settingsWindow || undefined,
        modal: !!(appState.mainWindow || appState.settingsWindow),
        webPreferences: {
            preload: path.join(__dirname, "../preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true
        },
        resizable: false,
        alwaysOnTop: true,
        show: false
    });

    appState.updateProgressWindow.loadFile(path.join(__dirname, "../sync-progress.html"));

    appState.updateProgressWindow.once('ready-to-show', () => {
        appState.updateProgressWindow?.show();
        appState.updateProgressWindow?.webContents.send('sync-progress', 'Connecting to updater server...');
    });
}

export function setupAutoUpdaterHandlers() {
    autoUpdater.on('checking-for-update', () => {
        console.log('[Updater] Checking for updates...');
        appState.isCheckingForUpdate = true;
    });

    autoUpdater.on('update-available', async (info) => {
        console.log('[Updater] Update available:', info.version);
        appState.isCheckingForUpdate = false;
        const targetWindow = appState.mainWindow || appState.settingsWindow;
        if (!targetWindow) return;

        const { response } = await dialog.showMessageBox(targetWindow, {
            type: 'info',
            title: 'Update Available',
            message: `Version ${info.version} is available.`,
            detail: 'Would you like to download it now?',
            buttons: ['Download', 'Later'],
            defaultId: 0
        });

        if (response === 0) {
            createUpdateProgressWindow();
            autoUpdater.downloadUpdate();
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('[Updater] Update not available. Current version:', info.version);
        if (appState.isCheckingForUpdate) {
            appState.isCheckingForUpdate = false;
            const targetWindow = appState.mainWindow || appState.settingsWindow;
            if (targetWindow) {
                dialog.showMessageBox(targetWindow, {
                    type: 'info',
                    title: 'No Updates',
                    message: 'You are currently running the latest version.'
                });
            }
        }
    });

    autoUpdater.on('error', (err) => {
        console.error('[Updater] Update error:', err);
        appState.isCheckingForUpdate = false;
        if (appState.updateProgressWindow && !appState.updateProgressWindow.isDestroyed()) {
            appState.updateProgressWindow.close();
            appState.updateProgressWindow = null;
        }

        // Only show error dialog if this was a manual check (indicated by isCheckingForUpdate being true initially)
        // or if we want to always notify. Let's keep it for now but suppress if it's too noisy in background.
        const targetWindow = appState.mainWindow || appState.settingsWindow;
        if (targetWindow) {
            dialog.showMessageBox(targetWindow, {
                type: 'error',
                title: 'Update Error',
                message: 'An error occurred while checking for updates.',
                detail: err == null ? "unknown error" : (err.stack || err).toString()
            });
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.floor(progressObj.percent);
        const downloadedBytes = (progressObj.transferred / 1024 / 1024).toFixed(2);
        const totalBytes = (progressObj.total / 1024 / 1024).toFixed(2);
        console.log(`[Updater] Download progress: ${percent}%`);

        if (appState.updateProgressWindow && !appState.updateProgressWindow.isDestroyed()) {
            appState.updateProgressWindow.webContents.send('sync-progress', `Downloading... ${percent}% (${downloadedBytes} MB / ${totalBytes} MB)`);
        }
    });

    autoUpdater.on('update-downloaded', async (info) => {
        console.log('[Updater] Update downloaded:', info.version);
        if (appState.updateProgressWindow && !appState.updateProgressWindow.isDestroyed()) {
            appState.updateProgressWindow.close();
            appState.updateProgressWindow = null;
        }

        const targetWindow = appState.mainWindow || appState.settingsWindow;
        if (!targetWindow) {
            autoUpdater.quitAndInstall();
            return;
        }

        const { response } = await dialog.showMessageBox(targetWindow, {
            type: 'info',
            title: 'Update Ready',
            message: 'A new version has been downloaded.',
            detail: 'Restart the application to apply the updates?',
            buttons: ['Restart Now', 'Later'],
            defaultId: 0
        });

        if (response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
}

export function startUpdateLoop() {
    // Initial check after 30 seconds
    setTimeout(() => {
        console.log('[Updater] Running initial startup update check');
        autoUpdater.checkForUpdates().catch(err => {
            console.error('[Updater] Initial check failed:', err);
        });
    }, 30000);

    // Periodic check every hour
    const ONE_HOUR = 60 * 60 * 1000;
    setInterval(() => {
        console.log('[Updater] Running periodic 1-hour update check');
        autoUpdater.checkForUpdates().catch(err => {
            console.error('[Updater] Periodic check failed:', err);
        });
    }, ONE_HOUR);
}
