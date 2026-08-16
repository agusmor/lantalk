// Main process. The server is a separate always-on program, so this
// process doesn't run anything besides the window and — as of voice —
// a permission handler so the mic doesn't get silently blocked.

const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');

let mainWindow = null;

// Config (identity.json etc) lives next to the actual executable in a
// packaged build. In dev (`electron .`), process.execPath points deep
// inside node_modules/electron/dist, which isn't useful as a config
// location — __dirname (the app's own source folder) is the sane
// stand-in there. Renderer can't compute this itself: app.isPackaged
// and process.execPath (the real one) are main-process-only.
function getConfigDir() {
  const base = app.isPackaged ? path.dirname(process.execPath) : __dirname;
  return path.join(base, 'config');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    backgroundColor: '#14161a',
    title: 'LanTalk',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      // Simple on purpose: this app only ever loads its own bundled UI
      // on a trusted local network, so we skip the usual sandboxing
      // ceremony (contextBridge/preload) that a public-facing app needs.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Electron doesn't reliably put the actual OS window into fullscreen
  // just because a page called element.requestFullscreen() — that part
  // of the sync is left to us on some platforms/window managers,
  // particularly on Linux.
  mainWindow.webContents.on('enter-html-full-screen', () => {
    mainWindow.setFullScreen(true);
  });
  mainWindow.webContents.on('leave-html-full-screen', () => {
    mainWindow.setFullScreen(false);
  });
}

// Opens the small picker window and resolves with whichever source id
// got clicked, or null if the window was closed without picking one.
// The listener cleanup here matters: without explicitly removing
// 'picker:selected' after each use, a cancelled pick leaves a dangling
// listener that would still be attached (harmlessly, but pointlessly)
// the next time someone shares.
function pickSource(sources) {
  return new Promise((resolve) => {
    const pickerWin = new BrowserWindow({
      width: 640,
      height: 480,
      parent: mainWindow,
      modal: true,
      resizable: true,
      title: 'Choose what to share',
      backgroundColor: '#14161a',
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    pickerWin.setMenuBarVisibility(false);

    let resolved = false;

    const onSelected = (_event, sourceId) => finish(sourceId);

    function finish(sourceId) {
      if (resolved) return;
      resolved = true;
      ipcMain.removeListener('picker:selected', onSelected);
      resolve(sourceId);
      if (!pickerWin.isDestroyed()) pickerWin.close();
    }

    ipcMain.on('picker:selected', onSelected);
    pickerWin.on('closed', () => finish(null));

    pickerWin.webContents.once('did-finish-load', () => {
      pickerWin.webContents.send('sources', sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
      })));
    });

    pickerWin.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  });
}

app.whenReady().then(() => {
  ipcMain.handle('get-config-dir', () => getConfigDir());

  // Electron blocks getUserMedia by default unless something explicitly
  // approves it — there's no OS-style prompt like a browser shows.
  // Since this app only ever asks for the mic (never camera, never
  // other permissions), it's safe to just auto-approve media and deny
  // anything else outright rather than build a real prompt UI for a
  // LAN tool. `session.defaultSession` only exists once the app is
  // ready, so this has to live in here rather than at module scope.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'fullscreen', 'window-management', 'display-capture'].includes(permission));
  });

  // Unlike a browser, Electron has no built-in "choose what to share"
  // picker — getDisplayMedia() in the renderer just fails silently
  // without this. This is what makes "Share Screen" work at all, and
  // now covers both full screens and individual windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 180 },
    });

    if (sources.length === 0) {
      callback({}); // nothing available — getDisplayMedia will reject
      return;
    }

    if (sources.length === 1) {
      callback({ video: sources[0] }); // only one option, nothing to choose
      return;
    }

    const chosenId = await pickSource(sources);
    const chosen = sources.find((s) => s.id === chosenId);
    callback(chosen ? { video: chosen } : {}); // {} = user cancelled, getDisplayMedia rejects
  });

  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
