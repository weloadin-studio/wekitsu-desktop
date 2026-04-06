import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("api", {
    ping: () => "pong",
});

contextBridge.exposeInMainWorld('versions', {
    node: () => process.versions.node,
    chrome: () => process.versions.chrome,
    electron: () => process.versions.electron
});

contextBridge.exposeInMainWorld('electronAPI', {
    openExplorer: (path: string) => ipcRenderer.invoke('open-path', path),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings: { wekitsuUrl?: string, workspacePath: string, mayaPath?: string, blenderPath?: string, photoshopPath?: string, substancePath?: string }) => ipcRenderer.invoke('save-settings', settings),
    selectDirectory: () => ipcRenderer.invoke('select-directory'),
    selectFile: () => ipcRenderer.invoke('select-file'),
    checkWorkspacePath: (relativePath: string) => ipcRenderer.invoke('check-path-exists', relativePath),
    openFileExplorer: (relativePath: string, type: string) => ipcRenderer.invoke('open-file-explorer', relativePath, type),
    getDirectoryContents: (dirPath: string) => ipcRenderer.invoke('get-directory-contents', dirPath),
    openWithApp: (filePath: string, appKey: string) => ipcRenderer.invoke('open-with-app', filePath, appKey),
    getLinkedWorkspaceTasks: () => ipcRenderer.invoke('get-linked-workspace-tasks'),
    linkToWorkspace: (taskId: string, relativePath: string) => ipcRenderer.invoke('link-to-workspace', { taskId, relativePath }),
    unlinkFromWorkspace: (taskId: string, relativePath: string) => ipcRenderer.invoke('unlink-from-workspace', { taskId, relativePath }),
    onSyncProgress: (callback: (event: any, filename: string) => void) => ipcRenderer.on('sync-progress', callback),
    getTask: (taskId: string) => ipcRenderer.invoke('api-get-task', taskId),
    createAsset: (payload: any) => ipcRenderer.invoke('api-create-asset', payload),
    linkAssetTask: (payload: { assetId: string, taskId: string }) => ipcRenderer.invoke('api-link-asset-task', payload),
    getLinkedTask: (assetId: string) => ipcRenderer.invoke('api-get-linked-task', assetId),
    getLinkedAssets: (taskId: string) => ipcRenderer.invoke('api-get-linked-assets', taskId),
    deleteLinkedAsset: (assetId: string) => ipcRenderer.invoke('api-delete-linked-asset', assetId),
    deleteAssetFiles: (payload: any) => ipcRenderer.invoke('api-delete-asset-files', payload),
    submitSnapshot: (payload: any) => ipcRenderer.invoke('api-snapshot', payload),
    getSnapshots: (taskId: string) => ipcRenderer.invoke('api-get-snapshots', taskId),
    rollbackSnapshot: (taskId: string, commitId: string) => ipcRenderer.invoke('api-rollback-snapshot', { taskId, commitId }),
    deleteSnapshot: (taskId: string, commitId: string) => ipcRenderer.invoke('api-delete-snapshot', { taskId, commitId }),
    processMedia: (filePath: string, type: 'thumbnail' | 'preview') => ipcRenderer.invoke('api-process-media', { filePath, type }),
    cleanupMedia: (filePaths: string[]) => ipcRenderer.invoke('api-cleanup-media', filePaths),
    getDefaultComments: () => ipcRenderer.invoke('api-get-default-comments'),
    createDefaultComment: (payload: any) => ipcRenderer.invoke('api-create-default-comment', payload),
    updateDefaultComment: (id: string, comment: string) => ipcRenderer.invoke('api-update-default-comment', id, comment),
    deleteDefaultComment: (id: string) => ipcRenderer.invoke('api-delete-default-comment', id),
    getPathForFile: (file: File) => webUtils.getPathForFile(file)
});
