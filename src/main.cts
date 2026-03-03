import type { BrowserWindow as BrowserWindowType } from "electron";
const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, dialog } = require("electron");
import path from "path";
import fs from "fs";
import { autoUpdater } from "electron-updater";
import Store from "electron-store";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import archiver from "archiver";

if (ffmpegStatic) {
    ffmpeg.setFfmpegPath(ffmpegStatic);
}

const isPackaged = process.mainModule?.filename.indexOf('app.asar') !== -1;
dotenv.config({ path: isPackaged ? path.join(process.resourcesPath, '.env') : path.join(__dirname, '../.env') });

const store = new Store({ name: 'wekitsu-settings', projectName: 'wekitsu-desktop' } as any);

// We handle update flow interactively
autoUpdater.autoDownload = false;
let isCheckingForUpdate = false;
let updateProgressWindow: BrowserWindowType | null = null;

const isDev = !app.isPackaged;
let mainWindow: BrowserWindowType | null = null;
let settingsWindow: BrowserWindowType | null = null;

// Use the wekitsu logo for tray and window icon
const iconUrl = path.join(__dirname, '../icon.png');
const icon = nativeImage.createFromPath(iconUrl);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, commandLine, workingDirectory) => {
        // Someone tried to run a second instance, we should focus our window.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            if (!mainWindow.isVisible()) mainWindow.show();
            mainWindow.focus();
        } else if (settingsWindow) {
            if (settingsWindow.isMinimized()) settingsWindow.restore();
            if (!settingsWindow.isVisible()) settingsWindow.show();
            settingsWindow.focus();
        }
    });

    // --- Forward Main Process Logs to DevTools ---
    const originalLog = console.log;
    const originalError = console.error;

    function forwardToDevTools(type: 'log' | 'error', ...args: any[]) {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
                const safeMsg = msg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
                mainWindow.webContents.executeJavaScript(`console.${type}("[Main Process] ${safeMsg}")`).catch(() => { });
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
        setupIpcHandlers();
        createMenu();

        // Setup interactive update handlers
        setupAutoUpdaterHandlers();

        // precise "checkForUpdatesAndNotify" is good for default behavior
        // (Removing default notify to rely on explicit checks via menu)
        // autoUpdater.checkForUpdatesAndNotify();

        checkSettingsAndStart();
    });
}

function checkSettingsAndStart() {
    const workspacePath = store.get("workspacePath") as string | undefined;

    if (workspacePath) {
        if (!mainWindow) {
            createWindow();
        }
    } else {
        createSettingsWindow();
    }
}

function setupAutoUpdaterHandlers() {
    autoUpdater.on('checking-for-update', () => {
        isCheckingForUpdate = true;
    });

    autoUpdater.on('update-available', async (info) => {
        isCheckingForUpdate = false;
        const targetWindow = mainWindow || settingsWindow;
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
            // User clicked Download
            createUpdateProgressWindow();
            autoUpdater.downloadUpdate();
        }
    });

    autoUpdater.on('update-not-available', () => {
        if (isCheckingForUpdate) {
            isCheckingForUpdate = false;
            const targetWindow = mainWindow || settingsWindow;
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
        isCheckingForUpdate = false;
        if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
            updateProgressWindow.close();
            updateProgressWindow = null;
        }

        const targetWindow = mainWindow || settingsWindow;
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

        if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
            updateProgressWindow.webContents.send('sync-progress', `Downloading... ${percent}% (${downloadedBytes} MB / ${totalBytes} MB)`);
        }
    });

    autoUpdater.on('update-downloaded', async () => {
        if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
            updateProgressWindow.close();
            updateProgressWindow = null;
        }

        const targetWindow = mainWindow || settingsWindow;
        if (!targetWindow) {
            // Safety fallback if closed out early
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

function createUpdateProgressWindow() {
    if (updateProgressWindow) return;

    updateProgressWindow = new BrowserWindow({
        width: 400,
        height: 120,
        frame: false,
        parent: mainWindow || settingsWindow || undefined,
        modal: !!(mainWindow || settingsWindow),
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true
        },
        resizable: false,
        alwaysOnTop: true,
        show: false
    });

    updateProgressWindow.loadFile(path.join(__dirname, "sync-progress.html"));

    updateProgressWindow.once('ready-to-show', () => {
        updateProgressWindow?.show();
        updateProgressWindow?.webContents.send('sync-progress', 'Connecting to updater server...');
    });
}

function setupIpcHandlers() {
    ipcMain.handle('open-path', async (event: any, fullPath: any) => {
        try {
            console.log('opening path', fullPath);
            const workspacePath = store.get("workspacePath") as string | undefined;
            if (!workspacePath) {
                return "Workspace path is not configured.";
            }

            const targetPath = path.join(workspacePath, fullPath);
            // Security check: Ensure path does not contain '..' to prevent directory traversal attacks if not intended
            // const safePath = path.normalize(fullPath).replace(/^(\.\.(\/|\\|$))+/, '');
            const result = await shell.openPath(targetPath);
            if (result) {
                console.error(`Error opening path: ${result}`);
            }
            return result;
        } catch (error) {
            console.error('Failed to open path:', error);
            return error instanceof Error ? error.message : 'Unknown error occurred';
        }
    });

    ipcMain.handle('get-settings', () => {
        return {
            workspacePath: store.get("workspacePath") || ""
        };
    });

    ipcMain.handle('save-settings', (event, settings: { workspacePath: string }) => {
        store.set("workspacePath", settings.workspacePath);

        if (settingsWindow) {
            settingsWindow.close();
        }

        if (!mainWindow) {
            createWindow();
        }

        return { success: true };
    });

    ipcMain.handle('select-directory', async () => {
        if (!settingsWindow) return null;
        const result = await dialog.showOpenDialog(settingsWindow, {
            properties: ['openDirectory']
        });
        if (result.canceled) {
            return null;
        } else {
            return result.filePaths[0];
        }
    });

    ipcMain.handle('check-path-exists', (event, relativePath: string) => {
        const workspacePath = store.get("workspacePath") as string | undefined;
        if (!workspacePath) return false;

        try {
            const fullPath = path.join(workspacePath, relativePath);
            return fs.existsSync(fullPath);
        } catch (error) {
            console.error("Error checking path existence:", error);
            return false;
        }
    });

    ipcMain.handle('link-to-workspace', async (event, payload: { taskId: string, relativePath: string }) => {
        console.log(`[Desktop IPC] link-to-workspace called for Task: ${payload.taskId} -> ${payload.relativePath}`);
        const workspaceDir = store.get("workspacePath") as string | undefined;

        if (!workspaceDir) {
            return { success: false, error: "Workspace path not configured" };
        }

        const destPath = path.join(workspaceDir, payload.relativePath);

        let progressWindow: BrowserWindowType | null = new BrowserWindow({
            width: 400,
            height: 120,
            frame: false,
            parent: mainWindow || undefined,
            modal: !!mainWindow,
            webPreferences: {
                preload: path.join(__dirname, "preload.cjs"),
                nodeIntegration: false,
                contextIsolation: true
            },
            resizable: false,
            alwaysOnTop: true,
            show: false
        });

        progressWindow.loadFile(path.join(__dirname, "sync-progress.html"));

        await new Promise<void>((resolve) => {
            if (!progressWindow) return resolve();
            progressWindow.once('ready-to-show', () => {
                progressWindow?.show();
                setTimeout(resolve, 50);
            });
        });

        try {
            const extract = require('extract-zip');
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';

            if (progressWindow && !progressWindow.isDestroyed()) {
                progressWindow.webContents.send('sync-progress', 'Fetching snapshot info...');
            }

            const snapshotRes = await fetch(`${apiUrl}/snapshots/${payload.taskId}`);
            if (!snapshotRes.ok) {
                throw new Error(`Failed to fetch snapshots: ${snapshotRes.statusText}`);
            }
            const snapshots = await snapshotRes.json();

            if (!snapshots || snapshots.length === 0) {
                await fs.promises.mkdir(destPath, { recursive: true });
                if (progressWindow && !progressWindow.isDestroyed()) { progressWindow.close(); progressWindow = null; }
                return { success: true };
            }

            const latestSource = snapshots.find((s: any) => s.type === 'source');
            const latestExports = snapshots.find((s: any) => s.type === 'exports');
            const toDownload = [latestSource, latestExports].filter(Boolean);

            for (const snap of toDownload) {
                const commitId = snap.commitId;

                if (progressWindow && !progressWindow.isDestroyed()) {
                    progressWindow.webContents.send('sync-progress', `Downloading ${snap.type} zip...`);
                }

                const zipUrl = `${apiUrl}/assets/${payload.taskId}/${commitId}/contents.zip`;
                const zipRes = await fetch(zipUrl);

                if (!zipRes.ok) {
                    if (zipRes.status === 404) {
                        // Skip if the zip is missing for this type
                        continue;
                    }
                    throw new Error(`Failed to download contents.zip for ${snap.type}: ${zipRes.statusText}`);
                }

                const arrayBuffer = await zipRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                const snapDestPath = path.join(destPath, snap.type);
                await fs.promises.mkdir(snapDestPath, { recursive: true });
                const tempZipPath = path.join(app.getPath('temp'), `contents-${snap.type}-${payload.taskId}-${Date.now()}.zip`);
                await fs.promises.writeFile(tempZipPath, buffer);

                if (progressWindow && !progressWindow.isDestroyed()) {
                    progressWindow.webContents.send('sync-progress', `Extracting ${snap.type}...`);
                }

                await extract(tempZipPath, { dir: snapDestPath });
                await fs.promises.unlink(tempZipPath);
            }

            if (progressWindow && !progressWindow.isDestroyed()) { progressWindow.close(); progressWindow = null; }

            const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
            linkedTasks[payload.taskId] = payload.relativePath;
            store.set("linkedTasks", linkedTasks);

            console.log(`[Desktop IPC] link-to-workspace completed successfully for Task: ${payload.taskId}`);
            return { success: true };
        } catch (error: any) {
            console.error(`[Desktop IPC] Error linking to workspace for Task ${payload.taskId}:`, error);
            if (progressWindow && !progressWindow.isDestroyed()) { progressWindow.close(); progressWindow = null; }
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('unlink-from-workspace', async (event, payload: { taskId: string, relativePath: string }) => {
        console.log(`[Desktop IPC] unlink-from-workspace called for Task: ${payload.taskId} -> ${payload.relativePath}`);
        const workspaceDir = store.get("workspacePath") as string | undefined;

        if (!workspaceDir) {
            return { success: false, error: "Workspace path not configured" };
        }

        try {
            const targetPath = path.join(workspaceDir, payload.relativePath);
            if (fs.existsSync(targetPath)) {
                let currentWindow = mainWindow;
                if (!currentWindow || currentWindow.isDestroyed()) {
                    const windows = BrowserWindow.getAllWindows();
                    currentWindow = windows.length > 0 ? windows[0] : null;
                }

                const dialogOpts = {
                    type: 'warning' as const,
                    buttons: ['Yes, delete it', 'Cancel'],
                    defaultId: 1,
                    title: 'Confirm Deletion',
                    message: 'Are you sure you want to delete the local workspace asset folder?',
                    detail: `This will permanently delete the folder: ${targetPath}`
                };

                const { response } = currentWindow
                    ? await dialog.showMessageBox(currentWindow, dialogOpts)
                    : await dialog.showMessageBox(dialogOpts);

                if (response !== 0) {
                    return { success: false, cancelled: true };
                }

                await fs.promises.rm(targetPath, { recursive: true, force: true });
            }

            const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
            delete linkedTasks[payload.taskId];
            store.set("linkedTasks", linkedTasks);

            console.log(`[Desktop IPC] unlink-from-workspace completed successfully for Task: ${payload.taskId}`);
            return { success: true };
        } catch (error: any) {
            console.error(`[Desktop IPC] Error unlinking from workspace for Task ${payload.taskId}:`, error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-create-asset', async (event, payload: any) => {
        console.log(`[Desktop IPC] api-create-asset called. Payload:`, payload);
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/createAsset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            console.log(`[Desktop IPC] api-create-asset responded with status: ${response.status}`);
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('[Desktop IPC] API createAsset error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-link-asset-task', async (event, payload: { assetId: string, taskId: string }) => {
        console.log(`[Desktop IPC] api-link-asset-task called for Asset: ${payload.assetId} -> Task: ${payload.taskId}`);
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/asset-task-links`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            console.log(`[Desktop IPC] api-link-asset-task responded with status: ${response.status}`);
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('[Desktop IPC] API linkAssetTask error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-get-linked-task', async (event, assetId: string) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/asset-task-links/${assetId}`);
            if (response.status === 404) return { success: true, data: null };
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getLinkedTask error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-get-task', async (event, taskId: string) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/get-task/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getTask error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-get-linked-assets', async (event, taskId: string) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/asset-task-links/task/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getLinkedAssets error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-delete-linked-asset', async (event, assetId: string) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/asset-task-links/${assetId}`, {
                method: 'DELETE'
            });
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API deleteLinkedAsset error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-process-media', async (event, { filePath, type }: { filePath: string, type: 'thumbnail' | 'preview' }) => {
        try {
            const outPath = path.join(app.getPath('temp'), `processed-${type}-${Date.now()}.${type === 'thumbnail' ? 'png' : 'mp4'}`);

            return new Promise((resolve, reject) => {
                let command = ffmpeg(filePath);

                if (type === 'thumbnail') {
                    command = command
                        .outputOptions([
                            "-vf",
                            "scale=500:281:force_original_aspect_ratio=decrease,pad=500:281:(ow-iw)/2:(oh-ih)/2"
                        ])
                        .toFormat("image2");
                } else {
                    command = command
                        .outputOptions([
                            "-t 10",
                            "-vf", "scale='min(720,iw)':-2",
                            "-c:v libx264",
                            "-crf 23",
                            "-preset fast",
                            "-an"
                        ])
                        .toFormat("mp4");
                }

                command
                    .on("end", () => {
                        resolve({ success: true, processedPath: outPath });
                    })
                    .on("error", (err) => {
                        console.error(`[ffmpeg] process media error:`, err);
                        reject({ success: false, error: err.message });
                    })
                    .save(outPath);
            });
        } catch (error: any) {
            console.error('API process media error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-cleanup-media', async (event, filePaths: string[]) => {
        try {
            for (const filePath of filePaths) {
                if (filePath && fs.existsSync(filePath)) {
                    await fs.promises.unlink(filePath).catch(() => { });
                }
            }
            return { success: true };
        } catch (error: any) {
            console.error('API cleanup media error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-snapshot', async (event, payload: {
        taskId: string, type: string, message: string, username?: string, userId?: string, bypassZip?: boolean,
        thumbnailPath?: string, previewPath?: string
    }) => {
        console.log(`[Desktop IPC] api-snapshot called for Task: ${payload.taskId}, Type: ${payload.type}`);
        console.log(`[Desktop IPC] Snapshot message: "${payload.message}" | bypassZip: ${payload.bypassZip}`);
        try {
            const formData = new FormData();
            formData.append('taskId', payload.taskId);
            formData.append('type', payload.type);
            formData.append('message', payload.message);
            if (payload.username) formData.append('username', payload.username);
            if (payload.userId) formData.append('userId', payload.userId);
            if (payload.bypassZip !== undefined) formData.append('bypassZip', payload.bypassZip.toString());

            // ... (rest of form data appending) ...
            // Bypass API processing since we already did it locally
            formData.append('bypassProcessing', 'true');

            if (payload.thumbnailPath && fs.existsSync(payload.thumbnailPath)) {
                console.log(`[Desktop IPC]   -> Adding thumbnail to stream`);
                const buffer = await fs.promises.readFile(payload.thumbnailPath);
                const file = new File([buffer], 'thumbnail.png', { type: 'image/png' });
                formData.append('thumbnail', file);
            }

            if (payload.previewPath && fs.existsSync(payload.previewPath)) {
                console.log(`[Desktop IPC]   -> Adding preview video to stream`);
                const buffer = await fs.promises.readFile(payload.previewPath);
                const file = new File([buffer], 'preview.mp4', { type: 'video/mp4' });
                formData.append('preview', file);
            }

            let tempZipPath: string | null = null;
            if (!payload.bypassZip) {
                const workspacePath = store.get("workspacePath") as string | undefined;
                const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
                const relativePath = linkedTasks[payload.taskId];

                if (workspacePath && relativePath) {
                    const targetDir = path.join(workspacePath, relativePath, payload.type);
                    if (fs.existsSync(targetDir)) {
                        console.log(`[Desktop IPC]   -> Bundling workspace folder: ${targetDir}`);
                        tempZipPath = path.join(app.getPath('temp'), `snapshot-${Date.now()}.zip`);

                        await new Promise<void>((resolve, reject) => {
                            const output = fs.createWriteStream(tempZipPath!);
                            const archive = archiver('zip', { zlib: { level: 9 } });

                            output.on('close', () => resolve());
                            archive.on('error', (err) => reject(err));

                            archive.pipe(output);
                            archive.directory(targetDir, false);
                            archive.finalize();
                        });

                        const buffer = await fs.promises.readFile(tempZipPath);
                        const file = new File([buffer], 'contents.zip', { type: 'application/zip' });
                        formData.append('contentsZip', file);
                        console.log(`[Desktop IPC]   -> Bundle created successfully`);
                    }
                }
            }

            console.log(`[Desktop IPC] Sending payload to remote Wekitsu API...`);
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/snapshot`, {
                method: 'POST',
                body: formData
            });
            const data = await response.json();

            // Clean up temporary files
            if (payload.thumbnailPath && fs.existsSync(payload.thumbnailPath)) {
                await fs.promises.unlink(payload.thumbnailPath).catch(() => { });
            }
            if (payload.previewPath && fs.existsSync(payload.previewPath)) {
                await fs.promises.unlink(payload.previewPath).catch(() => { });
            }
            if (tempZipPath && fs.existsSync(tempZipPath)) {
                await fs.promises.unlink(tempZipPath).catch(() => { });
            }

            console.log(`[Desktop IPC] api-snapshot responded with status: ${response.status}`);
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('[Desktop IPC] API snapshot error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-get-snapshots', async (event, taskId: string) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/snapshots/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API get-snapshots error:', error);
            return { success: false, error: error.message };
        }
    });



    ipcMain.handle('api-delete-snapshot', async (event, { taskId, commitId }: { taskId: string, commitId: string }) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/snapshots/${taskId}/${commitId}`, {
                method: 'DELETE'
            });
            // DELETE usually returns 204 No Content
            if (response.status === 204) {
                return { success: true, status: response.status };
            }
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API delete-snapshot error:', error);
            return { success: false, error: error.message };
        }
    });



    ipcMain.handle('api-rollback-snapshot', async (event, { taskId, commitId }: { taskId: string, commitId: string }) => {
        console.log(`[Desktop IPC] api-rollback-snapshot called for Task: ${taskId}, Commit: ${commitId}`);
        try {
            const workspacePath = store.get("workspacePath") as string | undefined;
            const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
            const relativePath = linkedTasks[taskId];

            if (workspacePath && relativePath) {
                const targetWorkspaceDir = path.join(workspacePath, relativePath);

                let currentWindow = mainWindow;
                if (!currentWindow || currentWindow.isDestroyed()) {
                    const windows = BrowserWindow.getAllWindows();
                    currentWindow = windows.length > 0 ? windows[0] : null;
                }

                const dialogOpts = {
                    type: 'warning' as const,
                    buttons: ['Yes, Rollback', 'Cancel'],
                    defaultId: 1,
                    title: 'Confirm Rollback',
                    message: 'Are you sure you want to rollback to this snapshot?',
                    detail: `This will clear the existing workspace folder for this task: ${targetWorkspaceDir}. ANY UNSAVED LOCAL CHANGES WILL BE LOST!`
                };

                const { response } = currentWindow
                    ? await dialog.showMessageBox(currentWindow, dialogOpts)
                    : await dialog.showMessageBox(dialogOpts);

                if (response !== 0) {
                    console.log(`[Desktop IPC] Rollback cancelled by user for Task: ${taskId}`);
                    return { success: false, cancelled: true };
                }
            }

            console.log(`[Desktop IPC] Sending rollback request to Wekitsu API for commit: ${commitId}`);
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';

            // Determine snapshot type to properly extract it at the local path
            let snapType = 'source';
            try {
                const snapshotRes = await fetch(`${apiUrl}/snapshots/${taskId}`);
                if (snapshotRes.ok) {
                    const snapshots = await snapshotRes.json();
                    const snap = snapshots.find((s: any) => s.commitId === commitId);
                    if (snap) {
                        snapType = snap.type;
                    }
                }
            } catch (e) {
                console.error("[Desktop IPC] Failed to fetch snapshot details for type", e);
            }

            const response = await fetch(`${apiUrl}/snapshots/${taskId}/${commitId}/rollback`, {
                method: 'POST'
            });
            const data = await response.json();
            console.log(`[Desktop IPC] api-rollback-snapshot responded with status: ${response.status}`);

            if (response.ok && workspacePath && relativePath) {
                const extract = require('extract-zip');
                const targetWorkspaceDir = path.join(workspacePath, relativePath, snapType);

                try {
                    if (fs.existsSync(targetWorkspaceDir)) {
                        console.log(`[Desktop IPC] Deleting local target workspace dir: ${targetWorkspaceDir}`);
                        await fs.promises.rm(targetWorkspaceDir, { recursive: true, force: true });
                    }
                    await fs.promises.mkdir(targetWorkspaceDir, { recursive: true });
                } catch (e) {
                    console.error("[Desktop IPC] Failed to clear local workspace directory", e);
                }

                try {
                    console.log(`[Desktop IPC] Fetching contents zip for extraction...`);
                    const zipUrl = `${apiUrl}/assets/${taskId}/${commitId}/contents.zip`;
                    const zipRes = await fetch(zipUrl);

                    if (zipRes.ok) {
                        const arrayBuffer = await zipRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        const tempZipPath = path.join(app.getPath('temp'), `contents-${snapType}-${taskId}-${Date.now()}.zip`);
                        await fs.promises.writeFile(tempZipPath, buffer);

                        console.log(`[Desktop IPC] Zip fetched, extracting to: ${targetWorkspaceDir}`);
                        await extract(tempZipPath, { dir: targetWorkspaceDir });
                        await fs.promises.unlink(tempZipPath);
                        console.log(`[Desktop IPC] Rollback zip extraction complete.`);
                    }
                } catch (e) {
                    console.error("[Desktop IPC] Failed to extract contents locally", e);
                }
            }

            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('[Desktop IPC] API rollback-snapshot error:', error);
            return { success: false, error: error.message };
        }
    });
}

function createSettingsWindow() {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 500,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: icon,
        title: "Wekitsu Settings",
        autoHideMenuBar: true
    });

    settingsWindow.loadFile(path.join(__dirname, "settings.html"));

    settingsWindow.on('closed', () => {
        settingsWindow = null;
        if (!mainWindow && process.platform !== "darwin") {
            app.quit();
        }
    });
}

function createWindow() {
    if (mainWindow) {
        mainWindow.focus();
        return;
    }

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
        },
        icon: icon
    });

    mainWindow.setMenuBarVisibility(true);

    mainWindow.webContents.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    // mainWindow.loadURL("http://localhost:8080");
    mainWindow.loadURL("https://wekitsu.weloadin.lol/");
    // mainWindow.loadURL("https://192.168.88.189:8080");
    // mainWindow.webContents.openDevTools();
}



function createMenu() {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Settings',
                    click: () => createSettingsWindow()
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Check for Updates',
                    click: () => {
                        autoUpdater.checkForUpdatesAndNotify();
                    }
                },
                { type: 'separator' },
                {
                    label: 'About',
                    click: () => {
                        const targetWindow = mainWindow || settingsWindow;
                        if (targetWindow) {
                            dialog.showMessageBox(targetWindow, {
                                type: 'info',
                                title: 'About',
                                message: app.getName(),
                                detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode: ${process.versions.node}`,
                                buttons: ['OK'],
                                icon: icon
                            });
                        }
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
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

