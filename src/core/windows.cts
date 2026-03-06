import { app, BrowserWindow, nativeImage, screen } from "electron";
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

    const defaultBounds = { width: 1200, height: 800 };
    let windowBounds = store.get("windowBounds", defaultBounds) as any;
    const isMaximized = store.get("isMaximized", false) as boolean;

    // Ensure window is visible on at least one display
    if (windowBounds.x !== undefined && windowBounds.y !== undefined) {
        const displays = screen.getAllDisplays();
        const isVisible = displays.some(display => {
            const bounds = display.bounds;
            return (
                windowBounds.x >= bounds.x &&
                windowBounds.y >= bounds.y &&
                windowBounds.x < bounds.x + bounds.width &&
                windowBounds.y < bounds.y + bounds.height
            );
        });
        if (!isVisible) {
            windowBounds = defaultBounds;
        }
    }

    appState.mainWindow = new BrowserWindow({
        ...windowBounds,
        webPreferences: {
            preload: path.join(__dirname, "../preload.cjs"),
        },
        icon: getAppIcon()
    });

    if (isMaximized) {
        appState.mainWindow.maximize();
    }

    appState.mainWindow.on('close', () => {
        if (appState.mainWindow) {
            store.set("windowBounds", appState.mainWindow.getNormalBounds());
            store.set("isMaximized", appState.mainWindow.isMaximized());
        }
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
