/**
 * CEF Remote Debugging login – calls SteamClient.Auth.SetLoginToken()
 * directly via Chrome DevTools Protocol.
 *
 * This bypasses VDF file manipulation and encryption entirely,
 * using Steam's own internal IPC to set the login token.
 *
 * Requires Steam to be started with CEF remote debugging enabled
 * (e.g. via -cef-enable-remote-debugging flag or .cef-enable-remote-debugging marker file).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const log = require('./log');

// Ports to try for CEF remote debugging (Steam uses 8080 by default).
const CEF_PORTS = [8080, 8081, 8082];
const CEF_POLL_INTERVAL = 2000;  // ms between polls
const CEF_POLL_TIMEOUT  = 60000; // max wait for Steam CEF to be ready
const CDP_TIMEOUT       = 15000; // max wait for a CDP command response

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fetch JSON from a plain HTTP endpoint (no dependencies). */
function fetchJSON(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`HTTP timeout: ${url}`));
    }, timeout);

    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`JSON parse error: ${err.message}`)); }
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Create the marker file that tells Steam to enable CEF remote debugging.
 * Also returns the recommended extra CLI args for Steam.
 * @param {string} steamRoot
 * @returns {string[]} extra args for startSteam()
 */
function enableCEFDebugging(steamRoot) {
  // Marker file approach (used by many Steam modding tools).
  const marker = path.join(steamRoot, '.cef-enable-remote-debugging');
  try {
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, '', { mode: 0o644 });
      log.info(`[CEF] Created marker file: ${marker}`);
    }
  } catch (err) {
    log.warn(`[CEF] Could not create marker file: ${err.message}`);
  }

  // Also pass the CLI flag as extra insurance.
  return ['-cef-enable-remote-debugging'];
}

// ---------------------------------------------------------------------------
// CEF target discovery
// ---------------------------------------------------------------------------

/**
 * Discover the CEF remote debugging port by trying known ports.
 * @returns {Promise<{port: number, targets: object[]}>}
 */
async function discoverCEF() {
  for (const port of CEF_PORTS) {
    try {
      const targets = await fetchJSON(`http://127.0.0.1:${port}/json`);
      if (Array.isArray(targets) && targets.length > 0) {
        return { port, targets };
      }
    } catch {}
  }
  return null;
}

/**
 * Also try reading the port from the running steamwebhelper process args.
 * @returns {number|null}
 */
function getCEFPortFromProcess() {
  try {
    const { execSync } = require('child_process');
    const output = execSync(
      "ps aux | grep steamwebhelper | grep -oP '(?<=--remote-debugging-port=)\\d+'",
      { encoding: 'utf8', stdio: 'pipe' }
    );
    const port = parseInt(output.trim().split('\n')[0], 10);
    if (!isNaN(port) && port > 0) return port;
  } catch {}
  return null;
}

/**
 * Wait for Steam's CEF debugging endpoint to become available.
 * @param {number} [timeout=CEF_POLL_TIMEOUT]
 * @returns {Promise<{port: number, targets: object[]}>}
 */
async function waitForCEF(timeout = CEF_POLL_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let lastErr = null;

  while (Date.now() < deadline) {
    // First try: process args.
    const pidPort = getCEFPortFromProcess();
    if (pidPort) {
      try {
        const targets = await fetchJSON(`http://127.0.0.1:${pidPort}/json`);
        if (Array.isArray(targets) && targets.length > 0) {
          return { port: pidPort, targets };
        }
      } catch {}
    }

    // Second try: known ports.
    const result = await discoverCEF();
    if (result) return result;

    await new Promise((r) => setTimeout(r, CEF_POLL_INTERVAL));
  }

  throw new Error(
    `Steam CEF debugging not available after ${Math.round(timeout / 1000)}s. ` +
    'Make sure Steam is started with CEF remote debugging enabled.'
  );
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

/**
 * Pick the best CEF target for executing SteamClient.Auth calls.
 *
 * Priority order:
 *   1. SharedJSContext – the shared context where SteamClient is always available
 *   2. SP (Steam window) – main Steam client UI
 *   3. Any "page" type target
 *   4. First target with a webSocketDebuggerUrl
 */
function findBestTarget(targets) {
  // 1. SharedJSContext
  let t = targets.find((t) => /SharedJSContext/i.test(t.title));
  if (t && t.webSocketDebuggerUrl) return t;

  // 2. SP (Steam window)
  t = targets.find((t) => /^SP\b/i.test(t.title));
  if (t && t.webSocketDebuggerUrl) return t;

  // 3. Any page-type target whose URL contains steam/library/login
  t = targets.find(
    (t) => t.type === 'page' && /login|library|steam/i.test(t.url || '')
  );
  if (t && t.webSocketDebuggerUrl) return t;

  // 4. Any page target
  t = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (t) return t;

  // 5. First target with WebSocket
  t = targets.find((t) => t.webSocketDebuggerUrl);
  return t || null;
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol execution
// ---------------------------------------------------------------------------

/**
 * Execute a JavaScript expression on a CEF target via CDP and return the value.
 *
 * @param {string} wsUrl  WebSocket debugger URL (e.g. ws://127.0.0.1:8080/devtools/page/XXX)
 * @param {string} expression  JavaScript expression to evaluate
 * @param {number} [timeout=CDP_TIMEOUT]
 * @returns {Promise<any>}  Resolved value from Runtime.evaluate
 */
function cdpEvaluate(wsUrl, expression, timeout = CDP_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgId = 1;

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('CDP Runtime.evaluate timed out'));
    }, timeout);

    ws.on('open', () => {
      ws.send(JSON.stringify({
        id: msgId,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.id !== msgId) return; // Ignore events / other responses.

        clearTimeout(timer);
        ws.close();

        if (msg.error) {
          return reject(new Error(`CDP error: ${JSON.stringify(msg.error)}`));
        }

        const res = msg.result || {};
        if (res.exceptionDetails) {
          return reject(new Error(
            `JS exception: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`
          ));
        }

        // res.result is { type, value, ... }
        resolve(res.result);
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket error: ${err.message}`));
    });
  });
}

// ---------------------------------------------------------------------------
// High-level login API
// ---------------------------------------------------------------------------

/**
 * Login to Steam by calling SteamClient.Auth.SetLoginToken() via CEF remote debugging.
 *
 * @param {string} refreshToken  The JWT refresh token from steam-session
 * @param {string} accountName   The Steam account name
 * @param {object} [opts]
 * @param {number} [opts.cefTimeout]  How long to wait for CEF to come up (ms)
 * @param {number} [opts.cdpTimeout]  How long to wait for the CDP call (ms)
 * @returns {Promise<{result: number, message: string}>}
 */
async function loginViaCEF(refreshToken, accountName, opts = {}) {
  const cefTimeout = opts.cefTimeout || CEF_POLL_TIMEOUT;
  const cdpTimeout = opts.cdpTimeout || CDP_TIMEOUT;

  // 1. Wait for CEF debugging to become available.
  log.info('[CEF] Waiting for Steam CEF debugging endpoint...');
  const { port, targets } = await waitForCEF(cefTimeout);
  log.info(`[CEF] Found ${targets.length} target(s) on port ${port}`);

  for (const t of targets) {
    log.info(`[CEF]   • "${t.title}" [${t.type}] ${t.url || '(no url)'}`);
  }

  // 2. Select the best target.
  const target = findBestTarget(targets);
  if (!target) {
    throw new Error('No suitable CEF target found. Steam may not be fully loaded yet.');
  }
  log.info(`[CEF] Using target: "${target.title}" → ${target.webSocketDebuggerUrl}`);

  // 3. Call SteamClient.Auth.SetLoginToken via CDP Runtime.evaluate.
  const js = `
    (async () => {
      if (typeof SteamClient === 'undefined' || !SteamClient.Auth) {
        return { error: 'SteamClient.Auth not available in this context' };
      }
      try {
        const res = await SteamClient.Auth.SetLoginToken(
          ${JSON.stringify(refreshToken)},
          ${JSON.stringify(accountName)}
        );
        return { result: res.result, message: res.message || '' };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    })()
  `;

  log.info('[CEF] Calling SteamClient.Auth.SetLoginToken()...');
  const value = await cdpEvaluate(target.webSocketDebuggerUrl, js, cdpTimeout);
  log.info(`[CEF] Raw CDP result: ${JSON.stringify(value)}`);

  if (!value || !value.value) {
    throw new Error(`Unexpected CDP result: ${JSON.stringify(value)}`);
  }

  const loginResult = value.value;

  if (loginResult.error) {
    // SteamClient.Auth not available → might need to try a different target.
    throw new Error(`SetLoginToken failed: ${loginResult.error}`);
  }

  log.info(`[CEF] SetLoginToken → result=${loginResult.result}, message="${loginResult.message}"`);

  // result === 1 means success in Steam's enum.
  if (loginResult.result !== 1) {
    throw new Error(
      `Steam rejected the login token (result=${loginResult.result}, msg="${loginResult.message}")`
    );
  }

  return loginResult;
}

/**
 * Retry loginViaCEF across all available targets until one works.
 * This handles the case where SteamClient.Auth isn't available in the first target.
 */
async function loginViaCEFWithRetry(refreshToken, accountName, opts = {}) {
  const cefTimeout = opts.cefTimeout || CEF_POLL_TIMEOUT;
  const cdpTimeout = opts.cdpTimeout || CDP_TIMEOUT;

  log.info('[CEF] Waiting for Steam CEF debugging endpoint...');
  const { port, targets } = await waitForCEF(cefTimeout);
  log.info(`[CEF] Found ${targets.length} target(s) on port ${port}`);

  for (const t of targets) {
    log.info(`[CEF]   • "${t.title}" [${t.type}] ${t.url || '(no url)'}`);
  }

  // Sort targets by priority (SharedJSContext first, then SP, then pages).
  const sorted = [...targets].filter((t) => t.webSocketDebuggerUrl);
  sorted.sort((a, b) => {
    const score = (t) => {
      if (/SharedJSContext/i.test(t.title)) return 0;
      if (/^SP\b/i.test(t.title)) return 1;
      if (t.type === 'page') return 2;
      return 3;
    };
    return score(a) - score(b);
  });

  const errors = [];

  for (const target of sorted) {
    log.info(`[CEF] Trying target: "${target.title}"...`);

    const js = `
      (async () => {
        if (typeof SteamClient === 'undefined' || !SteamClient.Auth) {
          return { error: 'SteamClient.Auth not available' };
        }
        try {
          const res = await SteamClient.Auth.SetLoginToken(
            ${JSON.stringify(refreshToken)},
            ${JSON.stringify(accountName)}
          );
          return { result: res.result, message: res.message || '' };
        } catch (err) {
          return { error: err.message || String(err) };
        }
      })()
    `;

    try {
      const value = await cdpEvaluate(target.webSocketDebuggerUrl, js, cdpTimeout);

      if (!value || !value.value) {
        errors.push(`${target.title}: unexpected result ${JSON.stringify(value)}`);
        continue;
      }

      const loginResult = value.value;

      if (loginResult.error) {
        log.info(`[CEF] Target "${target.title}": ${loginResult.error}`);
        errors.push(`${target.title}: ${loginResult.error}`);
        continue;
      }

      log.info(
        `[CEF] ✅ SetLoginToken via "${target.title}" → result=${loginResult.result}, message="${loginResult.message}"`
      );

      if (loginResult.result !== 1) {
        throw new Error(
          `Steam rejected the login token (result=${loginResult.result}, msg="${loginResult.message}")`
        );
      }

      return loginResult;
    } catch (err) {
      if (err.message.includes('Steam rejected')) throw err; // Don't retry on actual rejection.
      log.warn(`[CEF] Target "${target.title}" error: ${err.message}`);
      errors.push(`${target.title}: ${err.message}`);
    }
  }

  throw new Error(
    `SetLoginToken failed on all ${sorted.length} targets:\n  ${errors.join('\n  ')}`
  );
}

/**
 * Logout the currently logged-in Steam account via CEF remote debugging.
 * Tries multiple approaches: SetLoginToken with empty values, then SteamClient.User methods.
 *
 * @param {object} [opts]
 * @param {number} [opts.cefTimeout]  How long to wait for CEF to come up (ms)
 * @param {number} [opts.cdpTimeout]  How long to wait for the CDP call (ms)
 * @returns {Promise<boolean>}  true if logout was performed, false if no user was logged in
 */
async function logoutViaCEF(opts = {}) {
  const cefTimeout = opts.cefTimeout || CEF_POLL_TIMEOUT;
  const cdpTimeout = opts.cdpTimeout || CDP_TIMEOUT;

  log.info('[CEF] Waiting for Steam CEF to perform logout...');
  const { port, targets } = await waitForCEF(cefTimeout);
  log.info(`[CEF] Found ${targets.length} target(s) on port ${port}`);

  // Sort targets by priority (SharedJSContext first).
  const sorted = [...targets].filter((t) => t.webSocketDebuggerUrl);
  sorted.sort((a, b) => {
    const score = (t) => {
      if (/SharedJSContext/i.test(t.title)) return 0;
      if (/^SP\b/i.test(t.title)) return 1;
      if (t.type === 'page') return 2;
      return 3;
    };
    return score(a) - score(b);
  });

  const js = `
    (async () => {
      if (typeof SteamClient === 'undefined') {
        return { error: 'SteamClient not available' };
      }
      try {
        // Check if a user is currently logged in.
        const hasAuth = SteamClient.Auth && typeof SteamClient.Auth.SetLoginToken === 'function';
        if (!hasAuth) {
          return { error: 'SteamClient.Auth not available' };
        }
        // Clear the login token to force logout.
        await SteamClient.Auth.SetLoginToken('', '');
        return { success: true, method: 'ClearToken' };
      } catch (err) {
        return { error: err.message || String(err) };
      }
    })()
  `;

  const errors = [];

  for (const target of sorted) {
    log.info(`[CEF] Trying logout on target: "${target.title}"...`);
    try {
      const value = await cdpEvaluate(target.webSocketDebuggerUrl, js, cdpTimeout);

      if (!value || !value.value) {
        errors.push(`${target.title}: unexpected result ${JSON.stringify(value)}`);
        continue;
      }

      const result = value.value;

      if (result.error) {
        log.info(`[CEF] Target "${target.title}": ${result.error}`);
        errors.push(`${target.title}: ${result.error}`);
        continue;
      }

      log.info(`[CEF] \u2705 Logout via "${target.title}" (method: ${result.method})`);
      return true;
    } catch (err) {
      log.warn(`[CEF] Target "${target.title}" error: ${err.message}`);
      errors.push(`${target.title}: ${err.message}`);
    }
  }

  log.warn(`[CEF] Logout failed on all targets:\n  ${errors.join('\n  ')}`);
  return false;
}

module.exports = {
  enableCEFDebugging,
  waitForCEF,
  loginViaCEF,
  loginViaCEFWithRetry,
  logoutViaCEF,
  CEF_PORTS,
  CEF_POLL_TIMEOUT,
};
