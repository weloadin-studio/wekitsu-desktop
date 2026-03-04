import { ipcMain, dialog, app, BrowserWindow } from "electron";
import path from "path";
import fs from "fs";
import archiver from "archiver";
import { appState, store, WEKITSU_API_URL } from "../core/state.cjs";

export function setupSnapshotsIPC() {
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
            const response = await fetch(`${WEKITSU_API_URL}/snapshot`, {
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
            const response = await fetch(`${WEKITSU_API_URL}/snapshots/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API get-snapshots error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-delete-snapshot', async (event, { taskId, commitId }: { taskId: string, commitId: string }) => {
        try {
            const response = await fetch(`${WEKITSU_API_URL}/snapshots/${taskId}/${commitId}`, {
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

                let currentWindow = appState.mainWindow;
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

            // Determine snapshot type to properly extract it at the local path
            let snapType = 'source';
            try {
                const snapshotRes = await fetch(`${WEKITSU_API_URL}/snapshots/${taskId}`);
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

            const response = await fetch(`${WEKITSU_API_URL}/snapshots/${taskId}/${commitId}/rollback`, {
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
                    const zipUrl = `${WEKITSU_API_URL}/assets/${taskId}/${commitId}/contents.zip`;
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
