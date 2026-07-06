/**
 * CC Cockpit - Electron 壳
 *
 * 最薄的 Electron 封装：
 * - BrowserWindow 加载 localhost:3777
 * - 系统通知支持
 */

const { app, BrowserWindow, Notification } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'CC Cockpit',
    icon: path.join(__dirname, '..', 'ui', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL('http://localhost:3777');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// 收到 hook 通知时显示系统通知
function showNotification(title, body) {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// 导出给 hooks 使用
module.exports = { showNotification };
