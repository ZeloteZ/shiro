/**
 * Shiro 白 – Steam One-Click Login Tool
 * Electron main process.
 *
 * Protocol handler: shiro://login?token=XXX&api=https://kuroi.example.com
 *
 * Flow:
 *   1. OS opens shiro:// URL → Electron app starts
 *   2. Fetch credentials from Kuroi backend (one-time token)
 *   3. Authenticate via steam-session
 *   4. If guard needed → show input in GUI
 *   5. Inject token via CEF → auto-close
 */

'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const log = require('./core/log');

// Core modules
const { getSteamRoot } = require('./core/config');
const { killSteam, startSteam, waitForSteam } = require('./core/steam-process');
const { SteamAuth } = require('./core/steam-auth');
const { enableCEFDebugging, loginViaCEFWithRetry, logoutViaCEF } = require('./core/cef-login');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let currentAuth = null;
let tray = null;

function updateWindowsProtocolMetadata() {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    const { execSync } = require('child_process');
    execSync('reg add "HKCU\\Software\\Classes\\shiro" /ve /d "URL:Shiro" /f', { stdio: 'pipe' });
    execSync('reg add "HKCU\\Software\\Classes\\shiro" /v "URL Protocol" /d "" /f', { stdio: 'pipe' });
    execSync(`reg add "HKCU\\Software\\Classes\\shiro\\DefaultIcon" /ve /d "${process.execPath},0" /f`, { stdio: 'pipe' });
  } catch (error) {
    log.warn(`[LIFECYCLE] Failed to refresh Windows protocol metadata: ${error.message}`);
  }
}

function escapeDesktopExecArg(value) {
  return value.replace(/([\\\s"'`$&;<>|()*?!#[\]{}])/g, '\\$1');
}

function getLinuxProtocolExecArgs() {
  if (!app.isPackaged) {
    return [process.execPath, path.resolve(path.join(__dirname, '..'))];
  }

  if (process.env.APPIMAGE) {
    return [path.resolve(process.env.APPIMAGE)];
  }

  return [process.execPath];
}

function getLinuxApplicationsDirs() {
  const homeDir = app.getPath('home');
  const defaultDataHome = path.join(homeDir, '.local', 'share');
  const xdgDataHome = process.env.XDG_DATA_HOME || defaultDataHome;

  return [...new Set([
    path.join(xdgDataHome, 'applications'),
    path.join(defaultDataHome, 'applications'),
  ])];
}

function hasLinuxMimeAssociation(desktopFileName = 'shiro.desktop') {
  if (process.platform !== 'linux') {
    return false;
  }

  const homeDir = app.getPath('home');
  const configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
  const mimeAppsPaths = [
    path.join(configDir, 'mimeapps.list'),
    path.join(homeDir, '.local', 'share', 'applications', 'mimeapps.list'),
  ];

  return mimeAppsPaths.some((mimeAppsPath) => {
    if (!fs.existsSync(mimeAppsPath)) {
      return false;
    }

    try {
      const content = fs.readFileSync(mimeAppsPath, 'utf8');
      return content
        .split(/\r?\n/)
        .some((line) => {
          const trimmedLine = line.trim();
          return trimmedLine === `x-scheme-handler/shiro=${desktopFileName}`
            || trimmedLine === `x-scheme-handler/shiro=${desktopFileName};`
            || trimmedLine.includes(`x-scheme-handler/shiro=${desktopFileName};`);
        });
    } catch {
      return false;
    }
  });
}

function upsertMimeAppsSection(content, sectionName, key, value) {
  const lines = content.length ? content.split(/\r?\n/) : [];
  const normalizedHeader = `[${sectionName}]`;
  const updatedLines = [];
  let currentSection = null;
  let inserted = false;

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (/^\[.*\]$/.test(trimmedLine)) {
      if (currentSection === sectionName && !inserted) {
        updatedLines.push(`${key}=${value}`);
        inserted = true;
      }

      currentSection = trimmedLine.slice(1, -1);
      updatedLines.push(trimmedLine);
      continue;
    }

    if (currentSection === sectionName && trimmedLine.startsWith(`${key}=`)) {
      if (!inserted) {
        updatedLines.push(`${key}=${value}`);
        inserted = true;
      }
      continue;
    }

    updatedLines.push(line);
  }

  if (!inserted) {
    if (updatedLines.length && updatedLines[updatedLines.length - 1] !== '') {
      updatedLines.push('');
    }
    if (!updatedLines.includes(normalizedHeader)) {
      updatedLines.push(normalizedHeader);
    }
    updatedLines.push(`${key}=${value}`);
  }

  return `${updatedLines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function updateLinuxMimeApps(desktopFileName = 'shiro.desktop') {
  if (process.platform !== 'linux') {
    return false;
  }

  try {
    const homeDir = app.getPath('home');
    const configDir = process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config');
    const mimeAppsPath = path.join(configDir, 'mimeapps.list');

    fs.mkdirSync(configDir, { recursive: true });

    let content = fs.existsSync(mimeAppsPath)
      ? fs.readFileSync(mimeAppsPath, 'utf8')
      : '';

    content = upsertMimeAppsSection(content, 'Default Applications', 'x-scheme-handler/shiro', desktopFileName);
    content = upsertMimeAppsSection(content, 'Added Associations', 'x-scheme-handler/shiro', `${desktopFileName};`);

    fs.writeFileSync(mimeAppsPath, content, 'utf8');
    return true;
  } catch (error) {
    log.warn(`[LIFECYCLE] Failed to update Linux mimeapps.list: ${error.message}`);
    return false;
  }
}

function isManagedLinuxDesktopEntry(desktopEntry) {
  return desktopEntry.includes('X-Shiro-Managed=true')
    || (desktopEntry.includes('Name=Shiro')
      && desktopEntry.includes('MimeType=x-scheme-handler/shiro;'));
}

function updateLinuxProtocolMetadata() {
  if (process.platform !== 'linux') {
    return false;
  }

  try {
    const { execFileSync } = require('child_process');
    const applicationsDirs = getLinuxApplicationsDirs();
    const execArgs = getLinuxProtocolExecArgs();
    const desktopEntry = [
      '[Desktop Entry]',
      'Name=Shiro',
      'Comment=Steam One-Click Login Tool',
      `Exec=${execArgs.map(escapeDesktopExecArg).join(' ')} %u`,
      'Type=Application',
      'MimeType=x-scheme-handler/shiro;',
      'NoDisplay=true',
      'Categories=Utility;',
      'Terminal=false',
      'StartupNotify=false',
      'X-Shiro-Managed=true',
      '',
    ].join('\n');

    let wroteDesktopEntry = false;
    for (const applicationsDir of applicationsDirs) {
      const desktopFilePath = path.join(applicationsDir, 'shiro.desktop');
      const desktopFileExists = fs.existsSync(desktopFilePath);
      const currentDesktopEntry = desktopFileExists
        ? fs.readFileSync(desktopFilePath, 'utf8')
        : null;
      const shouldWriteDesktopEntry = !desktopFileExists
        || (currentDesktopEntry !== desktopEntry && isManagedLinuxDesktopEntry(currentDesktopEntry));

      if (!shouldWriteDesktopEntry) {
        continue;
      }

      fs.mkdirSync(applicationsDir, { recursive: true });
      fs.writeFileSync(desktopFilePath, desktopEntry, 'utf8');
      wroteDesktopEntry = true;
      log.info(`${desktopFileExists
        ? '[LIFECYCLE] Updated Linux desktop entry for shiro://'
        : '[LIFECYCLE] Created Linux desktop entry for shiro://'} (${applicationsDir})`);
    }

    let currentDefault = '';
    try {
      currentDefault = execFileSync('xdg-mime', ['query', 'default', 'x-scheme-handler/shiro'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {}

    if (currentDefault !== 'shiro.desktop') {
      execFileSync('xdg-mime', ['default', 'shiro.desktop', 'x-scheme-handler/shiro'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      log.info('[LIFECYCLE] Refreshed Linux protocol handler association');
    }

    updateLinuxMimeApps('shiro.desktop');

    if (wroteDesktopEntry) {
      for (const applicationsDir of applicationsDirs) {
        try {
          execFileSync('update-desktop-database', [applicationsDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {}
      }
    }

    let verifiedDefault = currentDefault;
    try {
      verifiedDefault = execFileSync('xdg-mime', ['query', 'default', 'x-scheme-handler/shiro'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {}

    return verifiedDefault === 'shiro.desktop' || hasLinuxMimeAssociation('shiro.desktop');
  } catch (error) {
    log.warn(`[LIFECYCLE] Failed to refresh Linux protocol metadata: ${error.message}`);
    return false;
  }
}

function registerProtocolHandler({ repairIfMissing = false } = {}) {
  const shouldRegister = !app.isPackaged || repairIfMissing;
  if (!shouldRegister) {
    return app.isDefaultProtocolClient('shiro');
  }

  if (app.isDefaultProtocolClient('shiro')) {
    updateWindowsProtocolMetadata();
    const linuxRegistered = process.platform === 'linux'
      ? updateLinuxProtocolMetadata()
      : true;
    return process.platform === 'linux' ? linuxRegistered : true;
  }

  let registered = false;
  if (!app.isPackaged && process.platform === 'win32') {
    registered = app.setAsDefaultProtocolClient('shiro', process.execPath, [path.resolve(path.join(__dirname, '..'))]);
  } else {
    registered = app.setAsDefaultProtocolClient('shiro');
  }

  let linuxRegistered = false;
  if (process.platform === 'linux') {
    linuxRegistered = updateLinuxProtocolMetadata();
  }

  const effectiveRegistered = registered
    || app.isDefaultProtocolClient('shiro')
    || linuxRegistered;

  if (effectiveRegistered) {
    if (registered) {
      log.info('[LIFECYCLE] Registered shiro:// protocol handler');
    } else if (linuxRegistered) {
      log.info('[LIFECYCLE] Registered shiro:// protocol handler via Linux desktop entry');
    }
    updateWindowsProtocolMetadata();
    return true;
  }

  log.warn('[LIFECYCLE] Failed to register shiro:// protocol handler');
  return false;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 540,
    frame: false,
    resizable: false,
    transparent: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#e8f4fd',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function sendStatus(status, message, data = {}) {
  log.info(`[STATUS] ${status}: ${message}`, Object.keys(data).length ? data : '');
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shiro:status', { status, message, ...data });
  }
}

// ---------------------------------------------------------------------------
// Credential fetch
// ---------------------------------------------------------------------------

async function fetchCredentials(token, apiUrl) {
  const endpoint = `/shiro/credentials/${encodeURIComponent(token)}`;

  // Try the provided URL first. If it fails and was HTTP, retry with HTTPS.
  // This handles servers that redirect http→https via non-standard schemes
  // (e.g. Traefik's "websecure://") that fetch() cannot follow.
  const urlsToTry = [apiUrl];
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:';
      urlsToTry.push(parsed.toString().replace(/\/$/, ''));
    }
  } catch {}

  let lastErr = null;
  for (const base of urlsToTry) {
    const url = `${base}${endpoint}`;
    log.info(`[FETCH] GET ${url}`);
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        redirect: 'follow',
      });
      log.info(`[FETCH] Response: ${resp.status} ${resp.statusText}`);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(
          resp.status === 404
            ? 'Login token expired or already used. Please try again from Kuroi.'
            : `Failed to fetch credentials: ${resp.status} ${body}`
        );
      }
      return resp.json();
    } catch (err) {
      log.warn(`[FETCH] Failed for ${base}: ${err.message}`);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Login flow
// ---------------------------------------------------------------------------

async function handleLogin(protocolUrl) {
  log.info('=== LOGIN FLOW START ===');
  log.info(`[PROTO] URL: ${protocolUrl}`);
  let url;
  try {
    url = new URL(protocolUrl);
  } catch {
    sendStatus('error', 'Invalid protocol URL');
    return;
  }

  const token = url.searchParams.get('token');
  const apiUrl = url.searchParams.get('api') || 'http://localhost:3000';

  if (!token) {
    sendStatus('error', 'No login token provided');
    return;
  }

  // Validate API URL scheme.
  try {
    const parsed = new URL(apiUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      sendStatus('error', `Unsupported API protocol: ${parsed.protocol} (use http or https)`);
      return;
    }
    log.info(`[PROTO] API: ${apiUrl} (${parsed.protocol})`);
  } catch {
    sendStatus('error', 'Invalid API URL');
    return;
  }

  // --- Phase 1: Fetch credentials ---
  sendStatus('fetching', 'Connecting to Kuroi...');

  let credentials;
  try {
    credentials = await fetchCredentials(token, apiUrl);
  } catch (err) {
    sendStatus('error', err.message);
    return;
  }

  const { account_name, password, persona_name } = credentials;
  if (!account_name || !password) {
    sendStatus('error', 'Invalid credentials received');
    return;
  }
  log.info(`[CREDS] Received credentials for account: ${account_name}, persona: ${persona_name || '(none)'} (password length: ${password.length})`);

  // --- Phase 2: Detect Steam ---
  let steamRoot;
  try {
    steamRoot = getSteamRoot();
    log.info(`[STEAM] Root: ${steamRoot}`);
  } catch (err) {
    sendStatus('error', `Steam not found: ${err.message}`);
    return;
  }

  // --- Phase 3: Authenticate ---
  sendStatus('authenticating', `Logging in as ${account_name}...`);

  currentAuth = new SteamAuth();

  let refreshToken;
  let steamId64 = null;
  let personaName = persona_name || account_name;
  try {
    const authResult = await new Promise((resolve, reject) => {
      currentAuth.on('authenticated', (result) => {
        log.info(`[AUTH] ✅ Authenticated! Token length: ${result.refreshToken.length}`);
        resolve(result);
      });

      currentAuth.on('guard-required', ({ type, detail }) => {
        log.info(`[AUTH] Guard required: type=${type}, detail=${detail}`);
        const messages = {
          email: `Steam Guard code sent to ${detail || 'your email'}`,
          totp: 'Enter your Steam Guard mobile authenticator code',
          device_confirm: 'Confirm on your Steam mobile app',
        };
        sendStatus('guard', messages[type] || 'Steam Guard required', {
          guardType: type,
          guardDetail: detail,
        });
      });

      currentAuth.on('error', (err) => {
        const msg = err.message || 'Authentication failed';
        log.error(`[AUTH] Error: ${msg}`);
        // If we're in guard state and code was wrong, let user retry.
        if (msg.includes('Invalid Steam Guard code') || msg.includes('InvalidLoginAuthCode')) {
          sendStatus('guard_error', 'Invalid code – please try again', {
            guardType: 'retry',
          });
        } else {
          reject(new Error(msg));
        }
      });

      log.info(`[AUTH] Starting login for ${account_name}...`);
      currentAuth.startLogin(account_name, password).catch(reject);
    });
    refreshToken = authResult.refreshToken;
    steamId64 = authResult.steamID?.getSteamID64?.() || authResult.steamID?.toString?.() || null;
  } catch (err) {
    sendStatus('error', err.message);
    _cleanup();
    return;
  }

  // --- Phase 4: CEF Login ---
  sendStatus('injecting', 'Preparing Steam login...');

  // ===== CEF Remote Debugging =====
  // Linux:   kill Steam → start with CEF → logout → kill → start with CEF → login
  // Windows: kill Steam → start with CEF → login (killing Steam auto-logs out)
  try {
    log.info('[LOGIN] Attempting CEF remote debugging method...');
    const isWindows = process.platform === 'win32';

    // --- Step 1: Kill existing Steam ---
    sendStatus('injecting', 'Stopping Steam...');
    try {
      log.info('[STEAM] Killing Steam...');
      await killSteam();
      const killWait = isWindows ? 4000 : 2000;
      log.info(`[STEAM] Steam killed. Waiting ${killWait / 1000}s...`);
      await new Promise((r) => setTimeout(r, killWait));
    } catch (err) {
      log.warn(`[STEAM] Kill issue (continuing): ${err.message}`);
    }

    const cefArgs = enableCEFDebugging(steamRoot);

    // On Linux, killing Steam does NOT log out the user, so we need an
    // explicit CEF logout cycle before the actual login.
    if (!isWindows) {
      // --- Step 2 (Linux): Start Steam with CEF for logout ---
      sendStatus('restarting', 'Starting Steam to sign out current account...');
      log.info(`[STEAM] Starting Steam with CEF args: ${cefArgs.join(' ')}`);
      startSteam(steamRoot, cefArgs);

      sendStatus('waiting', 'Waiting for Steam UI to load...');
      log.info('[STEAM] Waiting for Steam process...');
      await waitForSteam(20000);
      log.info('[STEAM] Steam process detected. Waiting for CEF...');
      await new Promise((r) => setTimeout(r, 5000));

      // --- Step 3 (Linux): Logout via CEF ---
      sendStatus('injecting', 'Signing out current account...');
      try {
        const loggedOut = await logoutViaCEF({
          cefTimeout: 45000,
          cdpTimeout: 15000,
        });
        if (loggedOut) {
          log.info('[CEF] ✅ Logout successful');
        } else {
          log.info('[CEF] No active session to logout (continuing)');
        }
      } catch (err) {
        log.warn(`[CEF] Logout attempt failed (continuing): ${err.message}`);
      }

      // --- Step 4 (Linux): Kill Steam again ---
      sendStatus('injecting', 'Stopping Steam after logout...');
      try {
        log.info('[STEAM] Killing Steam after logout...');
        await killSteam();
        log.info('[STEAM] Steam killed. Waiting 2s...');
        await new Promise((r) => setTimeout(r, 2000));
      } catch (err) {
        log.warn(`[STEAM] Kill issue (continuing): ${err.message}`);
      }
    } else {
      log.info('[STEAM] Windows: killing Steam auto-logs out – skipping CEF logout cycle');
    }

    // --- Start Steam with CEF for login ---
    sendStatus('restarting', 'Starting Steam with remote debugging...');
    log.info(`[STEAM] Starting Steam with CEF args: ${cefArgs.join(' ')}`);
    startSteam(steamRoot, cefArgs);

    sendStatus('waiting', 'Waiting for Steam UI to load...');
    log.info('[STEAM] Waiting for Steam process...');
    await waitForSteam(20000);
    log.info('[STEAM] Steam process detected. Waiting for CEF...');
    await new Promise((r) => setTimeout(r, 5000));

    // --- Step 6: Login via CEF ---
    sendStatus('injecting', 'Injecting login token via Steam API...');
    const loginIds = [steamId64, account_name].filter(Boolean);
    log.info(`[CEF] Login identifiers: ${loginIds.join(', ')}`);
    const result = await loginViaCEFWithRetry(refreshToken, loginIds, {
      cefTimeout: 45000,
      cdpTimeout: 15000,
    });

    log.info(`[CEF] ✅ Login successful! result=${result.result}`);
  } catch (err) {
    log.error(`[CEF] ❌ CEF login failed: ${err.message}`);
    sendStatus('error', `Login failed: ${err.message}`);
    _cleanup();
    return;
  }

  // --- Phase 5: Cleanup ---
  log.info('[CLEANUP] Success path – cleaning up');
  _cleanup();

  // --- Done! ---
  log.info(`=== LOGIN FLOW COMPLETE ✅ – account: ${account_name} ===`);
  sendStatus('done', `Logged in as ${account_name}!`);

  // Auto-close after 3 seconds.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.close();
    }
    app.quit();
  }, 3000);
}

/**
 * Cleanup auth session resources.
 */
function _cleanup() {
  log.info('[CLEANUP] Cleaning up');
  if (currentAuth) {
    currentAuth.destroy();
    currentAuth = null;
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

ipcMain.on('shiro:submit-guard', async (_event, code) => {
  log.info(`[IPC] Guard code submitted (${code.length} chars)`);
  if (!currentAuth) {
    log.warn('[IPC] No active auth session – ignoring guard code');
    return;
  }
  sendStatus('submitting', 'Verifying code...');
  try {
    await currentAuth.submitGuardCode(code);
    log.info('[IPC] Guard code sent to steam-session');
    // 'authenticated' or 'error' event will fire.
  } catch (err) {
    log.error(`[IPC] Guard code submission error: ${err.message}`);
    sendStatus('guard_error', err.message || 'Code submission failed');
  }
});

ipcMain.on('shiro:close', () => {
  log.info('[IPC] Close requested by renderer');
  _cleanup();
  app.quit();
});

// ---------------------------------------------------------------------------
// Protocol handler & app lifecycle
// ---------------------------------------------------------------------------

// Single instance lock.
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    log.info(`[LIFECYCLE] second-instance event, argv: ${argv.join(' ')}`);
    const url = argv.find((arg) => arg.startsWith('shiro://'));
    if (url) {
      log.info(`[LIFECYCLE] New protocol URL: ${url}`);
      // Close any existing window and start a new login.
      if (mainWindow) mainWindow.close();
      _cleanup();
      createWindow();
      // Wait for window to load before sending status.
      mainWindow.webContents.once('did-finish-load', () => {
        handleLogin(url);
      });
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Handle certificate errors (e.g. self-signed certs in development).
// In production, only trusted CA certificates are accepted.
app.on('certificate-error', (event, _webContents, url, _error, _cert, callback) => {
  const parsed = new URL(url);
  // Allow self-signed certs for localhost / 127.0.0.1 only.
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
    log.warn(`[TLS] Accepting self-signed certificate for ${parsed.hostname}`);
    event.preventDefault();
    callback(true);
  } else {
    log.error(`[TLS] Rejecting certificate for ${url}`);
    callback(false);
  }
});

app.whenReady().then(() => {
  log.clear();
  log.info('=== SHIRO STARTED ===');
  log.info(`[LIFECYCLE] argv: ${process.argv.join(' ')}`);
  log.info(`[LIFECYCLE] Electron ${process.versions.electron}, Node ${process.versions.node}`);

  const isRegisterMode = process.argv.includes('--register-protocol');

  // Installer builds should own protocol integration initially, but packaged apps
  // still repair the association when it was removed by an uninstall or upgrade.
  const protocolRegistered = registerProtocolHandler({ repairIfMissing: app.isPackaged || isRegisterMode });

  // --- System tray ---
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('Shiro 白');
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Shiro 白 anzeigen',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
          mainWindow.webContents.once('did-finish-load', () => {
            sendStatus('idle', 'Shiro is ready. Use Kuroi to initiate a Steam login.');
          });
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Beenden',
      click: () => {
        _cleanup();
        tray.destroy();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    } else {
      createWindow();
      mainWindow.webContents.once('did-finish-load', () => {
        sendStatus('idle', 'Shiro is ready. Use Kuroi to initiate a Steam login.');
      });
    }
  });

  // Parse protocol URL from command line args.
  const protocolUrl = process.argv.find((arg) => arg.startsWith('shiro://'));
  log.info(`[LIFECYCLE] Protocol URL from argv: ${protocolUrl || '(none)'}`);

  if (protocolUrl) {
    log.info('[LIFECYCLE] Mode: protocol login');
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      handleLogin(protocolUrl);
    });
  } else if (isRegisterMode) {
    // Just register and exit.
    log.info('[LIFECYCLE] Mode: register-protocol only');
    if (protocolRegistered) {
      console.log('✅ Shiro protocol handler registered.');
      console.log('   You can now use shiro:// URLs to launch Shiro.');
    } else {
      console.error('❌ Failed to register the Shiro protocol handler.');
      console.error('   Check the logs above and your desktop environment MIME settings.');
      process.exitCode = 1;
    }
    app.quit();
  } else {
    // No protocol URL – show info window.
    log.info('[LIFECYCLE] Mode: idle (no protocol URL)');
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => {
      sendStatus('idle', 'Shiro is ready. Use Kuroi to initiate a Steam login.');
    });
  }
});

app.on('window-all-closed', () => {
  // Don't quit – keep running in tray.
});
