import { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, dialog } from "electron";
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

const store = new Store();

// Connect the auto-updater to the main window for progress events if desired
// autoUpdater.on('update-downloaded', () => {
// autoUpdater.quitAndInstall(); 
// });

const isDev = !app.isPackaged;
let mainWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;

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

    // Create myWindow, load the rest of the app, etc...
    app.whenReady().then(() => {
        setupIpcHandlers();
        createMenu();

        // precise "checkForUpdatesAndNotify" is good for default behavior
        autoUpdater.checkForUpdatesAndNotify();

        checkSettingsAndStart();
    });
}

function checkSettingsAndStart() {
    const workspacePath = store.get("workspacePath") as string | undefined;
    const remotePath = store.get("remotePath") as string | undefined;

    if (workspacePath && remotePath) {
        if (!mainWindow) {
            createWindow();
        }
    } else {
        createSettingsWindow();
    }
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
            workspacePath: store.get("workspacePath") || "",
            remotePath: store.get("remotePath") || ""
        };
    });

    ipcMain.handle('save-settings', (event, settings: { workspacePath: string, remotePath: string }) => {
        store.set("workspacePath", settings.workspacePath);
        store.set("remotePath", settings.remotePath);

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
        const workspaceDir = store.get("workspacePath") as string | undefined;

        if (!workspaceDir) {
            return { success: false, error: "Workspace path not configured" };
        }

        const destPath = path.join(workspaceDir, payload.relativePath);

        let progressWindow: BrowserWindow | null = new BrowserWindow({
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

            return { success: true };
        } catch (error: any) {
            console.error("Error linking to workspace:", error);
            if (progressWindow && !progressWindow.isDestroyed()) { progressWindow.close(); progressWindow = null; }
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('unlink-from-workspace', async (event, payload: { taskId: string, relativePath: string }) => {
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

            return { success: true };
        } catch (error: any) {
            console.error("Error unlinking from workspace:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-create-asset', async (event, payload: any) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/createAsset`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API createAsset error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-link-asset-task', async (event, payload: { assetId: string, taskId: string }) => {
        try {
            const apiUrl = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';
            const response = await fetch(`${apiUrl}/asset-task-links`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API linkAssetTask error:', error);
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
        try {
            const formData = new FormData();
            formData.append('taskId', payload.taskId);
            formData.append('type', payload.type);
            formData.append('message', payload.message);
            if (payload.username) formData.append('username', payload.username);
            if (payload.userId) formData.append('userId', payload.userId);
            if (payload.bypassZip !== undefined) formData.append('bypassZip', payload.bypassZip.toString());

            // Bypass API processing since we already did it locally
            formData.append('bypassProcessing', 'true');

            if (payload.thumbnailPath && fs.existsSync(payload.thumbnailPath)) {
                const buffer = await fs.promises.readFile(payload.thumbnailPath);
                const file = new File([buffer], 'thumbnail.png', { type: 'image/png' });
                formData.append('thumbnail', file);
            }

            if (payload.previewPath && fs.existsSync(payload.previewPath)) {
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
                    }
                }
            }

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

            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API snapshot error:', error);
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
                    return { success: false, cancelled: true };
                }
            }

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
                console.error("Failed to fetch snapshot details for type", e);
            }

            const response = await fetch(`${apiUrl}/snapshots/${taskId}/${commitId}/rollback`, {
                method: 'POST'
            });
            const data = await response.json();

            if (response.ok && workspacePath && relativePath) {
                const extract = require('extract-zip');
                const targetWorkspaceDir = path.join(workspacePath, relativePath, snapType);

                try {
                    if (fs.existsSync(targetWorkspaceDir)) {
                        await fs.promises.rm(targetWorkspaceDir, { recursive: true, force: true });
                    }
                    await fs.promises.mkdir(targetWorkspaceDir, { recursive: true });
                } catch (e) {
                    console.error("Failed to clear local workspace directory", e);
                }

                try {
                    const zipUrl = `${apiUrl}/assets/${taskId}/${commitId}/contents.zip`;
                    const zipRes = await fetch(zipUrl);

                    if (zipRes.ok) {
                        const arrayBuffer = await zipRes.arrayBuffer();
                        const buffer = Buffer.from(arrayBuffer);
                        const tempZipPath = path.join(app.getPath('temp'), `contents-${snapType}-${taskId}-${Date.now()}.zip`);
                        await fs.promises.writeFile(tempZipPath, buffer);

                        await extract(tempZipPath, { dir: targetWorkspaceDir });
                        await fs.promises.unlink(tempZipPath);
                    }
                } catch (e) {
                    console.error("Failed to extract contents locally", e);
                }
            }

            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API rollback-snapshot error:', error);
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
    mainWindow.loadURL("http://localhost:8080");
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

