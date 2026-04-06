import Store from "electron-store";
import type { BrowserWindow as BrowserWindowType } from "electron";
import dotenv from "dotenv";
import path from "path";

const isPackaged = process.mainModule?.filename.indexOf('app.asar') !== -1;
dotenv.config({ path: isPackaged ? path.join(process.resourcesPath, '.env') : path.join(__dirname, '../../.env') });

export const store = new Store({ name: 'wekitsu-settings', projectName: 'wekitsu-desktop' } as any);

export let WEKITSU_URL = (store.get('wekitsuUrl') as string) || process.env.WEKITSU_URL || 'http://localhost:8080';
export let WEKITSU_API_URL = `${WEKITSU_URL}/wekitsu-api`;

export function updateWekitsuUrl(newUrl: string) {
    WEKITSU_URL = newUrl || process.env.WEKITSU_URL || 'http://localhost:8080';
    WEKITSU_API_URL = `${WEKITSU_URL}/wekitsu-api`;
}

export const appState = {
    mainWindow: null as BrowserWindowType | null,
    settingsWindow: null as BrowserWindowType | null,
    updateProgressWindow: null as BrowserWindowType | null,
    isCheckingForUpdate: false
};
