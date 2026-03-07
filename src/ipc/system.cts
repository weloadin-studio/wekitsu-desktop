import { ipcMain, shell, dialog, app, BrowserWindow } from "electron";
import type { BrowserWindow as BrowserWindowType } from "electron";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { appState, store, WEKITSU_API_URL } from "../core/state.cjs";
import { createWindow } from "../core/windows.cjs";

export function setupSystemIPC() {
    ipcMain.handle('open-path', async (event: any, fullPath: any) => {
        try {
            console.log('opening path', fullPath);
            const workspacePath = store.get("workspacePath") as string | undefined;
            if (!workspacePath) {
                return "Workspace path is not configured.";
            }

            const targetPath = path.join(workspacePath, fullPath);
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

    ipcMain.handle('get-linked-workspace-tasks', () => {
        const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
        return linkedTasks;
    });

    ipcMain.handle('save-settings', (event, settings: { workspacePath: string }) => {
        store.set("workspacePath", settings.workspacePath);

        if (appState.settingsWindow) {
            appState.settingsWindow.close();
        }

        if (!appState.mainWindow) {
            createWindow();
        }

        return { success: true };
    });

    ipcMain.handle('select-directory', async () => {
        if (!appState.settingsWindow) return null;
        const result = await dialog.showOpenDialog(appState.settingsWindow, {
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
            parent: appState.mainWindow || undefined,
            modal: !!appState.mainWindow,
            webPreferences: {
                preload: path.join(__dirname, "../preload.cjs"),
                nodeIntegration: false,
                contextIsolation: true
            },
            resizable: false,
            alwaysOnTop: true,
            show: false
        });

        progressWindow.loadFile(path.join(__dirname, "../sync-progress.html"));

        await new Promise<void>((resolve) => {
            if (!progressWindow) return resolve();
            progressWindow.once('ready-to-show', () => {
                progressWindow?.show();
                setTimeout(resolve, 50);
            });
        });

        try {
            const extract = require('extract-zip');
            if (progressWindow && !progressWindow.isDestroyed()) {
                progressWindow.webContents.send('sync-progress', 'Fetching snapshot info...');
            }

            const snapshotRes = await fetch(`${WEKITSU_API_URL}/snapshots/${payload.taskId}`);
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

                const zipUrl = `${WEKITSU_API_URL}/assets/${payload.taskId}/${commitId}/contents.zip`;
                const zipRes = await fetch(zipUrl);

                if (!zipRes.ok) {
                    if (zipRes.status === 404) {
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
                let currentWindow = appState.mainWindow;
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
}
