import { app, BrowserWindow, nativeImage } from "electron";
import path from "path";
import { appState, store, WEKITSU_URL } from "./state.cjs";

export function getAppIcon() {
    const iconUrl = path.join(__dirname, '../../icon.png');
    return nativeImage.createFromPath(iconUrl);
}

export function createSettingsWindow() {
    if (appState.settingsWindow) {
        appState.settingsWindow.focus();
        return;
    }

    appState.settingsWindow = new BrowserWindow({
        width: 500,
        height: 600,
        webPreferences: {
            preload: path.join(__dirname, "../preload.cjs"),
            nodeIntegration: false,
            contextIsolation: true
        },
        icon: getAppIcon(),
        title: "Wekitsu Settings",
        autoHideMenuBar: true
    });

    appState.settingsWindow.loadFile(path.join(__dirname, "../settings.html"));

    appState.settingsWindow.on('closed', () => {
        appState.settingsWindow = null;
        if (!appState.mainWindow && process.platform !== "darwin") {
            app.quit();
        }
    });
}

export function createWindow() {
    if (appState.mainWindow) {
        appState.mainWindow.focus();
        return;
    }

    appState.mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, "../preload.cjs"),
        },
        icon: getAppIcon()
    });

    appState.mainWindow.setMenuBarVisibility(true);

    appState.mainWindow.webContents.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
    appState.mainWindow.loadURL(WEKITSU_URL);
    // appState.mainWindow.webContents.openDevTools();
}

export function checkSettingsAndStart() {
    const workspacePath = store.get("workspacePath") as string | undefined;

    if (workspacePath) {
        if (!appState.mainWindow) {
            createWindow();
        }
    } else {
        createSettingsWindow();
    }
}
