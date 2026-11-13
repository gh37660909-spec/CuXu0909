const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');

const SERVER_PORT = 5330 + Math.floor(Math.random() * 400);
let serverProcess = null;
let mainWindow = null;

function appRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
}

function dataRoot() {
  return path.join(app.getPath('userData'), 'data');
}

function waitForServer(timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const probe = () => {
      const req = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/api/app', timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) return resolve();
        retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - started > timeoutMs) return reject(new Error('本地服务启动超时'));
      setTimeout(probe, 300);
    };
    probe();
  });
}

async function startServer() {
  const root = appRoot();
  const serverPath = path.join(root, 'server.mjs');
  if (!fs.existsSync(serverPath)) throw new Error(`找不到 server.mjs：${serverPath}`);
  fs.mkdirSync(dataRoot(), { recursive: true });
  serverProcess = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(SERVER_PORT),
      NALO_DATA_DIR: dataRoot(),
      NALO_WORKSPACE: path.join(app.getPath('userData'), 'workspace')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  serverProcess.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
  serverProcess.on('exit', (code) => {
    if (code && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('server-exit', code);
  });
  await waitForServer();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 660,
    title: 'Nalo Code',
    backgroundColor: '#f7f7f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.loadURL(`http://127.0.0.1:${SERVER_PORT}/`);
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.insertCSS('.win-controls{display:none!important}');
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      await startServer();
      createWindow();
    } catch (error) {
      const { dialog } = require('electron');
      dialog.showErrorBox('Nalo Code 启动失败', String(error.message || error));
      app.quit();
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill(); } catch { }
  }
});
