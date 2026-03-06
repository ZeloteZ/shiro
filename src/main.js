/**
 * Shiro 白 – Steam One-Click Login Tool
 * Electron main process.
 *
 * Protocol handler: shiro://login?token=XXX&api=http://localhost:3000
 *
 * Flow:
 *   1. OS opens shiro:// URL → Electron app starts
 *   2. Fetch credentials from Kuroi backend (one-time token)
 *   3. Authenticate via steam-session
 *   4. If guard needed → show input in GUI
 *   5. Inject token → restart Steam → restore VDFs → auto-close
 */

'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const log = require('./core/log');

// Core modules
const { getSteamRoot } = require('./core/config');
const { encryptConnectCache } = require('./core/crypto');
const { extractSteamId64 } = require('./core/token-utils');
const {
  writeConnectCache,
  updateLoginusers,
  setAutoLoginUser,
  ensureConfigAccounts,
} = require('./core/vdf');
const { SteamBackup, getFilesToProtect } = require('./core/backup');
const { killSteam, startSteam, waitForSteam } = require('./core/steam-process');
const { SteamAuth } = require('./core/steam-auth');
const { enableCEFDebugging, loginViaCEFWithRetry } = require('./core/cef-login');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let currentAuth = null;
let backup = null;
let tray = null;

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
  const url = `${apiUrl}/shiro/credentials/${encodeURIComponent(token)}`;
  log.info(`[FETCH] GET ${url}`);
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
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

  // --- Phase 3: (VDF backup is deferred to fallback path if needed) ---

  // --- Phase 4: Authenticate ---
  sendStatus('authenticating', `Logging in as ${account_name}...`);

  currentAuth = new SteamAuth();

  let refreshToken;
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
  } catch (err) {
    sendStatus('error', err.message);
    _restoreAndCleanup();
    return;
  }

  // --- Phase 5: CEF Login (primary) or VDF injection (fallback) ---
  sendStatus('injecting', 'Preparing Steam login...');

  let loginSuccess = false;

  // ===== PRIMARY METHOD: CEF Remote Debugging =====
  // Start Steam with CEF debugging enabled and call SetLoginToken()
  // directly via Chrome DevTools Protocol. This bypasses VDF/encryption.
  try {
    log.info('[LOGIN] Attempting CEF remote debugging method...');

    // Kill existing Steam first.
    sendStatus('injecting', 'Stopping Steam...');
    try {
      log.info('[STEAM] Killing Steam before CEF login...');
      await killSteam();
      log.info('[STEAM] Steam killed. Waiting 2s...');
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err) {
      log.warn(`[STEAM] Kill issue (continuing): ${err.message}`);
    }

    // Enable CEF remote debugging and start Steam.
    sendStatus('restarting', 'Starting Steam with remote debugging...');
    const cefArgs = enableCEFDebugging(steamRoot);
    log.info(`[STEAM] Starting Steam with CEF args: ${cefArgs.join(' ')}`);
    startSteam(steamRoot, cefArgs);

    sendStatus('waiting', 'Waiting for Steam UI to load...');
    log.info('[STEAM] Waiting for Steam process...');
    await waitForSteam(20000);
    log.info('[STEAM] Steam process detected. Waiting for CEF...');

    // Give Steam a few extra seconds to fully initialize the UI.
    await new Promise((r) => setTimeout(r, 5000));

    // Call SetLoginToken via CEF.
    sendStatus('injecting', 'Injecting login token via Steam API...');
    const result = await loginViaCEFWithRetry(refreshToken, account_name, {
      cefTimeout: 45000,
      cdpTimeout: 15000,
    });

    log.info(`[CEF] ✅ Login successful! result=${result.result}`);
    loginSuccess = true;
  } catch (err) {
    log.warn(`[CEF] ❌ CEF method failed: ${err.message}`);
    log.info('[LOGIN] Falling back to VDF injection method...');
  }

  // ===== FALLBACK METHOD: VDF Injection =====
  // Write encrypted token to VDF files (traditional approach).
  if (!loginSuccess) {
    try {
      // Kill Steam again if it was started by the CEF attempt.
      sendStatus('injecting', 'Stopping Steam for VDF injection...');
      try {
        await killSteam();
        await new Promise((r) => setTimeout(r, 2000));
      } catch {}

      // Backup VDFs.
      backup = new SteamBackup(steamRoot);
      backup.setup();
      const filesToProtect = getFilesToProtect(steamRoot);
      log.info(`[BACKUP] Protecting ${filesToProtect.length} files`);
      for (const f of filesToProtect) {
        backup.protect(f);
      }

      sendStatus('injecting', 'Injecting login token into VDF files...');
      const steamId64 = extractSteamId64(refreshToken);
      log.info(`[INJECT] SteamID64: ${steamId64}`);
      const encryptedHex = encryptConnectCache(account_name, refreshToken);
      log.info(`[INJECT] Encrypted token: ${encryptedHex.length} hex chars`);

      writeConnectCache(steamRoot, account_name, encryptedHex);
      updateLoginusers(steamRoot, account_name, steamId64, personaName);
      setAutoLoginUser(steamRoot, account_name);
      ensureConfigAccounts(steamRoot, account_name, steamId64);
      log.info('[INJECT] ✅ All VDF writes complete');

      await new Promise((r) => setTimeout(r, 1000));

      // Start Steam.
      sendStatus('restarting', 'Starting Steam...');
      startSteam(steamRoot);
      sendStatus('waiting', 'Waiting for Steam to start...');
      await waitForSteam(15000);
      await new Promise((r) => setTimeout(r, 5000));
      log.info('[STEAM] ✅ Steam started (VDF fallback)');
      loginSuccess = true;
    } catch (err) {
      log.error(`[INJECT] ❌ VDF injection failed: ${err.message}`);
      sendStatus('error', `Login failed: ${err.message}`);
      _restoreAndCleanup();
      return;
    }
  }

  // --- Phase 6: Cleanup ---
  if (loginSuccess) {
    log.info('[CLEANUP] Success path – cleaning up');
    _cleanupWithoutRestore();
  }

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
 * Restore VDFs to original state and cleanup – used on FAILURE only.
 * Undoes all VDF modifications so the user's Steam stays untouched.
 */
function _restoreAndCleanup() {
  log.info('[CLEANUP] Failure path – restoring original VDFs');
  if (backup) {
    try { backup.restoreAll(); log.info('[CLEANUP] VDFs restored'); } catch (err) { log.error(`[CLEANUP] Restore error: ${err.message}`); }
    try { backup.cleanup(); } catch {}
    backup = null;
  }
  if (currentAuth) {
    currentAuth.destroy();
    currentAuth = null;
  }
}

/**
 * Cleanup WITHOUT restoring VDFs – used on SUCCESS.
 * The modified VDFs (ConnectCache, loginusers, registry, config)
 * must remain so Steam picks up the injected login token.
 */
function _cleanupWithoutRestore() {
  log.info('[CLEANUP] Discarding backups (keeping modified VDFs)');
  if (backup) {
    try { backup.cleanup(); log.info('[CLEANUP] Backup files removed'); } catch {}
    backup = null;
  }
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
  _restoreAndCleanup();
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
      _restoreAndCleanup();
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

app.whenReady().then(() => {
  log.clear();
  log.info('=== SHIRO STARTED ===');
  log.info(`[LIFECYCLE] argv: ${process.argv.join(' ')}`);
  log.info(`[LIFECYCLE] Electron ${process.versions.electron}, Node ${process.versions.node}`);

  // Register protocol handler.
  if (!app.isDefaultProtocolClient('shiro')) {
    app.setAsDefaultProtocolClient('shiro');
    log.info('[LIFECYCLE] Registered shiro:// protocol handler');
  }

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
        _restoreAndCleanup();
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
  } else if (process.argv.includes('--register-protocol')) {
    // Just register and exit.
    log.info('[LIFECYCLE] Mode: register-protocol only');
    console.log('✅ Shiro protocol handler registered.');
    console.log('   You can now use shiro:// URLs to launch Shiro.');
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
