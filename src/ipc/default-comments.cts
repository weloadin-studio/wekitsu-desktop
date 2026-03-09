import { ipcMain } from "electron";
import { WEKITSU_API_URL } from "../core/state.cjs";

export function setupDefaultCommentsIPC() {
    ipcMain.handle("api-get-default-comments", async () => {
        try {
            const res = await fetch(`${WEKITSU_API_URL}/default-comments`);
            if (!res.ok) {
                return { success: false, error: `HTTP ${res.status}` };
            }
            const data = await res.json();
            return { success: true, data };
        } catch (error: any) {
            console.error("IPC get default comments error:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("api-create-default-comment", async (_, { productionId, assetTypeId, taskTypeId, comment, checklist }) => {
        try {
            const res = await fetch(`${WEKITSU_API_URL}/default-comments`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productionId, assetTypeId, taskTypeId, comment, checklist }),
            });
            if (!res.ok) {
                return { success: false, error: `HTTP ${res.status}` };
            }
            const data = await res.json();
            return { success: true, data };
        } catch (error: any) {
            console.error("IPC create default comment error:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("api-update-default-comment", async (_, id, comment, checklist) => {
        try {
            const res = await fetch(`${WEKITSU_API_URL}/default-comments/${id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ comment, checklist })
            });
            if (!res.ok) {
                return { success: false, error: `HTTP ${res.status}` };
            }
            const data = await res.json();
            return { success: true, data };
        } catch (error: any) {
            console.error("IPC update default comment error:", error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle("api-delete-default-comment", async (_, id) => {
        try {
            const res = await fetch(`${WEKITSU_API_URL}/default-comments/${id}`, {
                method: "DELETE"
            });
            if (!res.ok) {
                return { success: false, error: `HTTP ${res.status}` };
            }
            return { success: true };
        } catch (error: any) {
            console.error("IPC delete default comment error:", error);
            return { success: false, error: error.message };
        }
    });
}
