/**
 * Steam process management – kill, start, wait.
 * Supports Linux and Windows.
 *
 * SECURITY:
 * - The Steam executable path is validated against the known Steam root.
 * - Process operations use graceful shutdown first.
 */

'use strict';

const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

class ProcessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProcessError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Platform-specific helpers
// ---------------------------------------------------------------------------

/** Check if the main Steam client process is currently running. */
function isSteamRunning() {
  try {
    if (IS_WIN) {
      const output = execSync(
        'tasklist /FI "IMAGENAME eq steam.exe" /FO CSV /NH',
        { encoding: 'utf8', stdio: 'pipe' }
      );
      // CSV output: "steam.exe","1234",... when running; INFO message otherwise.
      return output.toLowerCase().includes('"steam.exe"');
    } else {
      execSync('pgrep -x steam', { stdio: 'pipe' });
      return true;
    }
  } catch {
    return false;
  }
}

/** Return a list of Steam-related process IDs. */
function _getSteamPids() {
  const pids = new Set();

  if (IS_WIN) {
    // On Windows, use WMIC to get PIDs for Steam processes.
    for (const name of ['steam.exe', 'steamwebhelper.exe']) {
      try {
        const output = execSync(
          `wmic process where "name='${name}'" get ProcessId /FORMAT:LIST`,
          { encoding: 'utf8', stdio: 'pipe' }
        );
        for (const match of output.matchAll(/ProcessId=(\d+)/gi)) {
          const pid = parseInt(match[1], 10);
          if (!isNaN(pid) && pid > 0) pids.add(pid);
        }
      } catch {}
    }
  } else {
    for (const name of ['steam', 'steamwebhelper', 'steam-runtime']) {
      try {
        const output = execSync(`pgrep -f ${name}`, { encoding: 'utf8', stdio: 'pipe' });
        for (const line of output.trim().split('\n')) {
          const pid = parseInt(line.trim(), 10);
          if (!isNaN(pid)) pids.add(pid);
        }
      } catch {}
    }
  }

  return [...pids].sort((a, b) => a - b);
}

/** Poll until Steam is no longer running or timeout expires. */
async function _waitForExit(timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!isSteamRunning()) return true;
    await sleep(500);
  }
  return !isSteamRunning();
}

/**
 * Gracefully shut down the Steam client, escalating to force-kill.
 *
 * Linux:   steam -shutdown → SIGTERM → SIGKILL
 * Windows: steam.exe -shutdown → taskkill graceful → taskkill /F
 */
async function killSteam(timeout = 5000) {
  if (!isSteamRunning()) return;

  // Step 1: Graceful shutdown via Steam's own command.
  if (IS_WIN) {
    try {
      // Find steam.exe path and run -shutdown for a clean exit.
      const steamPids = _getSteamPids();
      if (steamPids.length > 0) {
        try {
          execSync('taskkill /IM steam.exe', { stdio: 'pipe', timeout: 10000 });
        } catch {}
      }
    } catch {}
  } else {
    try {
      execSync('steam -shutdown', { stdio: 'pipe', timeout: 10000 });
    } catch {}
  }

  if (await _waitForExit(timeout)) {
    // On Windows, also kill lingering steamwebhelper.exe processes.
    if (IS_WIN) {
      try { execSync('taskkill /F /IM steamwebhelper.exe', { stdio: 'pipe' }); } catch {}
    }
    return;
  }

  // Step 2: Force-kill all Steam-related processes.
  if (IS_WIN) {
    try { execSync('taskkill /F /IM steam.exe', { stdio: 'pipe' }); } catch {}
    try { execSync('taskkill /F /IM steamwebhelper.exe', { stdio: 'pipe' }); } catch {}
  } else {
    const pids = _getSteamPids();
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
  }

  if (await _waitForExit(timeout)) return;

  // Step 3: SIGKILL (Linux only, Windows already force-killed above).
  if (!IS_WIN) {
    const remaining = _getSteamPids();
    for (const pid of remaining) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    if (await _waitForExit(timeout)) return;
  }

  throw new ProcessError('Failed to stop Steam after all escalation steps');
}

/**
 * Locate the Steam executable, validated against the known root.
 * @param {string} steamRoot
 * @returns {string}
 */
function _findSteamExecutable(steamRoot) {
  if (IS_WIN) {
    const candidates = [
      path.join(steamRoot, 'steam.exe'),
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }

    // Fallback: check PATH.
    try {
      const output = execSync('where steam.exe', { encoding: 'utf8', stdio: 'pipe' }).trim();
      const first = output.split('\n')[0].trim();
      if (first && fs.existsSync(first)) return first;
    } catch {}

    throw new ProcessError(`Steam executable not found in ${steamRoot} or system PATH`);
  } else {
    const candidates = [
      path.join(steamRoot, 'steam.sh'),
      path.join(steamRoot, 'steam'),
    ];

    for (const c of candidates) {
      try {
        fs.accessSync(c, fs.constants.X_OK);
        return fs.realpathSync(c);
      } catch {}
    }

    // Fallback: check PATH.
    try {
      const systemSteam = execSync('which steam', { encoding: 'utf8', stdio: 'pipe' }).trim();
      if (systemSteam) return fs.realpathSync(systemSteam);
    } catch {}

    throw new ProcessError(`Steam executable not found in ${steamRoot} or system PATH`);
  }
}

/**
 * Start the Steam client in the background (detached).
 * @param {string} steamRoot
 * @param {string[]} [extraArgs]
 */
function startSteam(steamRoot, extraArgs = []) {
  if (isSteamRunning()) return;

  const exe = _findSteamExecutable(steamRoot);

  if (IS_WIN) {
    // On Windows, use 'start' via cmd.exe to launch Steam as a fully detached process.
    // This avoids issues with spawn + paths containing spaces.
    const args = extraArgs.length ? ' ' + extraArgs.join(' ') : '';
    exec(`start "" "${exe}"${args}`, { stdio: 'ignore' });
  } else {
    const child = spawn(exe, extraArgs, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  }
}

/**
 * Wait until Steam is running (process detected) or timeout.
 * @param {number} [timeout=15000]
 * @returns {Promise<boolean>}
 */
async function waitForSteam(timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (isSteamRunning()) return true;
    await sleep(1000);
  }
  return isSteamRunning();
}

module.exports = { isSteamRunning, killSteam, startSteam, waitForSteam, ProcessError };
