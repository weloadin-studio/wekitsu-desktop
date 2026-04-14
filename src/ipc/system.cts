import { ipcMain, shell, dialog, app, BrowserWindow } from "electron";
import type { BrowserWindow as BrowserWindowType } from "electron";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import { appState, store, WEKITSU_API_URL, WEKITSU_URL, updateWekitsuUrl } from "../core/state.cjs";
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
            wekitsuUrl: store.get("wekitsuUrl") || WEKITSU_URL,
            workspacePath: store.get("workspacePath") || "",
            mayaPath: store.get("mayaPath") || "",
            blenderPath: store.get("blenderPath") || "",
            photoshopPath: store.get("photoshopPath") || "",
            substancePainterPath: store.get("substancePainterPath") || "",
            pureRefPath: store.get("pureRefPath") || "",
            substanceDesignerPath: store.get("substanceDesignerPath") || "",
            zbrushPath: store.get("zbrushPath") || ""
        };
    });

    ipcMain.handle('get-linked-workspace-tasks', () => {
        const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
        return linkedTasks;
    });

    ipcMain.handle('save-settings', (event, settings: { wekitsuUrl?: string, workspacePath: string, mayaPath?: string, blenderPath?: string, photoshopPath?: string, substancePainterPath?: string, pureRefPath?: string, substanceDesignerPath?: string, zbrushPath?: string }) => {
        let urlChanged = false;
        if (settings.wekitsuUrl !== undefined) {
            if (store.get("wekitsuUrl") !== settings.wekitsuUrl) {
                urlChanged = true;
            }
            store.set("wekitsuUrl", settings.wekitsuUrl);
            updateWekitsuUrl(settings.wekitsuUrl);
        }
        
        store.set("workspacePath", settings.workspacePath);
        if (settings.mayaPath !== undefined) store.set("mayaPath", settings.mayaPath);
        if (settings.blenderPath !== undefined) store.set("blenderPath", settings.blenderPath);
        if (settings.photoshopPath !== undefined) store.set("photoshopPath", settings.photoshopPath);
        if (settings.substancePainterPath !== undefined) store.set("substancePainterPath", settings.substancePainterPath);
        if (settings.pureRefPath !== undefined) store.set("pureRefPath", settings.pureRefPath);
        if (settings.substanceDesignerPath !== undefined) store.set("substanceDesignerPath", settings.substanceDesignerPath);
        if (settings.zbrushPath !== undefined) store.set("zbrushPath", settings.zbrushPath);

        if (appState.settingsWindow) {
            appState.settingsWindow.close();
        }

        if (!appState.mainWindow) {
            createWindow();
        } else if (urlChanged) {
            appState.mainWindow.loadURL(WEKITSU_URL);
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

    ipcMain.handle('select-file', async () => {
        if (!appState.settingsWindow) return null;
        const result = await dialog.showOpenDialog(appState.settingsWindow, {
            properties: ['openFile']
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

    ipcMain.handle('open-file-explorer', async (event, relativePath: string, type: 'source' | 'exports') => {
        const workspaceDir = store.get("workspacePath") as string | undefined;
        if (!workspaceDir) return { success: false, error: "Workspace path not configured" };
        
        const targetPath = path.join(workspaceDir, relativePath, type);
        
        if (!fs.existsSync(targetPath)) {
            await fs.promises.mkdir(targetPath, { recursive: true });
        }

        let explorerWindow = new BrowserWindow({
            width: 800,
            height: 600,
            parent: appState.mainWindow || undefined,
            webPreferences: {
                preload: path.join(__dirname, "../preload.cjs"),
                nodeIntegration: false,
                contextIsolation: true
            },
            show: false,
            title: `Wekitsu Explorer - ${type === 'source' ? 'Source' : 'Exports'}`
        });

        explorerWindow.setMenu(null);
        
        const explorerUrl = `file://${path.join(__dirname, "../file-explorer.html")}?path=${encodeURIComponent(targetPath)}&root=${encodeURIComponent(targetPath)}`;
        explorerWindow.loadURL(explorerUrl);
        
        explorerWindow.once('ready-to-show', () => {
            explorerWindow.show();
        });

        return { success: true };
    });

    ipcMain.handle('get-directory-contents', async (event, dirPath: string) => {
        try {
            const items = await fs.promises.readdir(dirPath, { withFileTypes: true });
            const contents = items.map(item => ({
                name: item.name,
                isDirectory: item.isDirectory(),
                path: path.join(dirPath, item.name)
            }));
            
            contents.sort((a, b) => {
                if (a.isDirectory === b.isDirectory) {
                    return a.name.localeCompare(b.name);
                }
                return a.isDirectory ? -1 : 1;
            });
            return { success: true, contents };
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-with-app', async (event, filePath: string, appKey: string) => {
        try {
            const appPath = store.get(appKey) as string | undefined;
            if (!appPath) throw new Error(`${appKey} is not configured in settings.`);
            
            const { spawn } = require('child_process');
            let spawnArgs = [filePath];

            if (appKey === 'mayaPath') {
                let projPath = '';
                let currentDir = path.dirname(filePath);
                
                // 1. Look for workspace.mel traversing upwards
                while (currentDir && currentDir !== path.parse(currentDir).root) {
                    if (fs.existsSync(path.join(currentDir, 'workspace.mel'))) {
                        projPath = currentDir;
                        break;
                    }
                    currentDir = path.dirname(currentDir);
                }

                // 2. Fallback: if 'scenes' is in the path, use its parent
                if (!projPath) {
                    const scenesPattern = path.sep + 'scenes' + path.sep;
                    const scenesIndex = filePath.toLowerCase().lastIndexOf(scenesPattern);
                    if (scenesIndex !== -1) {
                        projPath = filePath.substring(0, scenesIndex);
                    }
                }

                // 3. Fallback: if 'source' is in the path, use its parent (Wekitsu asset root)
                if (!projPath) {
                    const sourcePattern = path.sep + 'source' + path.sep;
                    const sourceIndex = filePath.toLowerCase().lastIndexOf(sourcePattern);
                    if (sourceIndex !== -1) {
                        projPath = filePath.substring(0, sourceIndex);
                    }
                }

                // 4. Final fallback: just use the directory of the file
                if (!projPath) {
                    projPath = path.dirname(filePath);
                }

                if (projPath) {
                    spawnArgs.push('-proj', projPath);
                }
            }

            const child = spawn(appPath, spawnArgs, { detached: true, stdio: 'ignore' });
            child.unref();

            return { success: true };
        } catch (error: any) {
            return { success: false, error: error.message };
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
