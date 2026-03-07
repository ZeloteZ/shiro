/**
 * Steam installation path detection.
 * Supports Linux and Windows.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

/**
 * Return the Steam root directory for the current platform.
 * Supports STEAM_ROOT env override.
 * @returns {string} Resolved absolute path to Steam root.
 */
function getSteamRoot() {
  const envRoot = (process.env.STEAM_ROOT || '').trim();
  if (envRoot) {
    if (fs.existsSync(envRoot) && fs.statSync(envRoot).isDirectory()) {
      return fs.realpathSync(envRoot);
    }
    throw new Error(`STEAM_ROOT=${envRoot} does not exist or is not a directory`);
  }

  const home = os.homedir();
  const platform = process.platform;

  let candidates;

  if (platform === 'win32') {
    candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
      path.join(home, 'AppData', 'Local', 'Steam'),
      'C:\\Steam',
      'D:\\Steam',
      'D:\\SteamLibrary',
    ];
  } else {
    // Linux / macOS
    candidates = [
      path.join(home, '.steam', 'steam'),
      path.join(home, '.local', 'share', 'Steam'),
      path.join(home, '.steam'),
    ];
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        // On Windows, realpathSync may fail with junction-like paths; use resolve instead.
        try { return fs.realpathSync(candidate); } catch { return path.resolve(candidate); }
      }
    } catch {
      // Skip inaccessible paths.
    }
  }

  throw new Error('Steam installation not found. Searched: ' + candidates.join(', '));
}

module.exports = { getSteamRoot };
