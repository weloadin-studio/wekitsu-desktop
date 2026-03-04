import Store from "electron-store";
import type { BrowserWindow as BrowserWindowType } from "electron";
import dotenv from "dotenv";
import path from "path";

const isPackaged = process.mainModule?.filename.indexOf('app.asar') !== -1;
dotenv.config({ path: isPackaged ? path.join(process.resourcesPath, '.env') : path.join(__dirname, '../../.env') });

export const WEKITSU_URL = process.env.WEKITSU_URL || 'https://wekitsu.weloadin.lol';
export const WEKITSU_API_URL = process.env.WEKITSU_API_URL || 'https://wekitsu-api.weloadin.lol';

export const store = new Store({ name: 'wekitsu-settings', projectName: 'wekitsu-desktop' } as any);

export const appState = {
    mainWindow: null as BrowserWindowType | null,
    settingsWindow: null as BrowserWindowType | null,
    updateProgressWindow: null as BrowserWindowType | null,
    isCheckingForUpdate: false
};
