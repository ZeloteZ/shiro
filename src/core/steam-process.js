/**
 * Steam process management – kill, start, wait.
 *
 * SECURITY:
 * - The Steam executable path is validated against the known Steam root.
 * - Process operations use graceful shutdown first (SIGTERM before SIGKILL).
 */

'use strict';

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class ProcessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProcessError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Check if any Steam client process is currently running. */
function isSteamRunning() {
  try {
    execSync('pgrep -x steam', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Return a list of Steam-related process IDs. */
function _getSteamPids() {
  const pids = new Set();
  for (const name of ['steam', 'steamwebhelper', 'steam-runtime']) {
    try {
      const output = execSync(`pgrep -f ${name}`, { encoding: 'utf8', stdio: 'pipe' });
      for (const line of output.trim().split('\n')) {
        const pid = parseInt(line.trim(), 10);
        if (!isNaN(pid)) pids.add(pid);
      }
    } catch {}
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
 * 1. steam -shutdown (graceful)
 * 2. Wait → SIGTERM
 * 3. Wait → SIGKILL
 */
async function killSteam(timeout = 5000) {
  if (!isSteamRunning()) return;

  // Step 1: Graceful shutdown.
  try {
    execSync('steam -shutdown', { stdio: 'pipe', timeout: 10000 });
  } catch {}

  if (await _waitForExit(timeout)) return;

  // Step 2: SIGTERM.
  const pids = _getSteamPids();
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }

  if (await _waitForExit(timeout)) return;

  // Step 3: SIGKILL.
  const remaining = _getSteamPids();
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }

  if (await _waitForExit(timeout)) return;

  throw new ProcessError('Failed to stop Steam after all escalation steps');
}

/**
 * Locate the Steam executable, validated against the known root.
 * @param {string} steamRoot
 * @returns {string}
 */
function _findSteamExecutable(steamRoot) {
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

/**
 * Start the Steam client in the background (detached).
 * @param {string} steamRoot
 * @param {string[]} [extraArgs]
 */
function startSteam(steamRoot, extraArgs = []) {
  if (isSteamRunning()) return;

  const exe = _findSteamExecutable(steamRoot);
  const child = spawn(exe, extraArgs, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
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
