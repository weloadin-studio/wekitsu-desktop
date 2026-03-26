import { ipcMain } from "electron";
import { WEKITSU_API_URL, store } from "../core/state.cjs";
import path from "path";
import fs from "fs";

export function setupAssetsIPC() {
    ipcMain.handle('api-create-asset', async (event, payload: any) => {
        console.log(`[Desktop IPC] api-create-asset called. Payload:`, payload);
        try {
            const response = await fetch(`${WEKITSU_API_URL}/createAsset`, {
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
            const response = await fetch(`${WEKITSU_API_URL}/asset-task-links`, {
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
            const response = await fetch(`${WEKITSU_API_URL}/asset-task-links/${assetId}`);
            if (response.status === 404) return { success: true, data: null };
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getLinkedTask error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-get-linked-assets', async (event, taskId: string) => {
        try {
            const response = await fetch(`${WEKITSU_API_URL}/asset-task-links/task/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getLinkedAssets error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-delete-linked-asset', async (event, assetId: string) => {
        try {
            const response = await fetch(`${WEKITSU_API_URL}/asset-task-links/${assetId}`, {
                method: 'DELETE'
            });
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API deleteLinkedAsset error:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('api-delete-asset-files', async (event, payload: any) => {
        console.log(`[Desktop IPC] api-delete-asset-files called for Asset: ${payload.assetId}`);
        try {
            const response = await fetch(`${WEKITSU_API_URL}/deleteAsset`, {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await response.json();
            
            // Unlink from local workspace
            const workspaceDir = store.get("workspacePath") as string | undefined;
            if (workspaceDir && payload.projectName && payload.assetType && payload.assetName) {
                const targetPath = path.join(workspaceDir, payload.projectName, payload.assetType, payload.assetName);
                if (fs.existsSync(targetPath)) {
                    await fs.promises.rm(targetPath, { recursive: true, force: true });
                    console.log(`[Desktop IPC] Deleted local workspace folder: ${targetPath}`);
                }
                
                const linkedTasks = store.get("linkedTasks", {}) as Record<string, string>;
                let tasksUpdated = false;
                const assetPrefix = `${payload.projectName}/${payload.assetType}/${payload.assetName}/`;
                for (const taskId in linkedTasks) {
                    if (linkedTasks[taskId].startsWith(assetPrefix)) {
                        delete linkedTasks[taskId];
                        tasksUpdated = true;
                    }
                }
                if (tasksUpdated) {
                    store.set("linkedTasks", linkedTasks);
                }
            }

            console.log(`[Desktop IPC] api-delete-asset-files responded with status: ${response.status}`);
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('[Desktop IPC] API deleteAssetFiles error:', error);
            return { success: false, error: error.message };
        }
    });
}
