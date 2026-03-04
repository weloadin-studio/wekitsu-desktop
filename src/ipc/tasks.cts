import { ipcMain } from "electron";
import { WEKITSU_API_URL } from "../core/state.cjs";

export function setupTasksIPC() {
    ipcMain.handle('api-get-task', async (event, taskId: string) => {
        try {
            const response = await fetch(`${WEKITSU_API_URL}/get-task/${taskId}`);
            const data = await response.json();
            return { success: response.ok, data, status: response.status };
        } catch (error: any) {
            console.error('API getTask error:', error);
            return { success: false, error: error.message };
        }
    });
}
