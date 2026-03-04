import { app, dialog, Menu } from "electron";
import { autoUpdater } from "electron-updater";
import { appState } from "./state.cjs";
import { createSettingsWindow, getAppIcon } from "./windows.cjs";

export function createMenu() {
    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'File',
            submenu: [
                {
                    label: 'Settings',
                    click: () => createSettingsWindow()
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'forceReload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' }
            ]
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'Check for Updates',
                    click: () => {
                        autoUpdater.checkForUpdatesAndNotify();
                    }
                },
                { type: 'separator' },
                {
                    label: 'About',
                    click: () => {
                        const targetWindow = appState.mainWindow || appState.settingsWindow;
                        if (targetWindow) {
                            dialog.showMessageBox(targetWindow, {
                                type: 'info',
                                title: 'About',
                                message: app.getName(),
                                detail: `Version: ${app.getVersion()}\nElectron: ${process.versions.electron}\nChrome: ${process.versions.chrome}\nNode: ${process.versions.node}`,
                                buttons: ['OK'],
                                icon: getAppIcon()
                            });
                        }
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}
