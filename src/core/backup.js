/**
 * Backup & restore manager for Steam configuration files.
 *
 * Ensures Steam's installation is left in the same state it was
 * before Shiro performed a login. Every modified VDF file gets a
 * backup copy *before* any change. On completion, originals are restored.
 *
 * SECURITY:
 * - Backup dir has restricted permissions (0o700).
 * - Backups are zeroed out before deletion (defense in depth).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

const SENTINEL = '__SHIRO_FILE_DID_NOT_EXIST__';

class SteamBackup {
  constructor(steamRoot) {
    this._steamRoot = fs.realpathSync(steamRoot);
    this._backupDir = null;
    /** @type {Map<string, string>} originalPath → backupPath */
    this._backedUp = new Map();
  }

  /** Create a secure temporary directory for backups. */
  setup() {
    this._backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiro_backup_'));
    fs.chmodSync(this._backupDir, 0o700);
  }

  /**
   * Create a backup of a file before it is modified.
   * If the file does not exist, records that fact so restore
   * knows to delete any file Shiro created.
   */
  protect(filePath) {
    const resolved = fs.existsSync(filePath)
      ? fs.realpathSync(filePath)
      : path.resolve(filePath);

    if (this._backedUp.has(resolved)) return;
    if (!this._backupDir) throw new BackupError('SteamBackup.setup() must be called first');

    const safeName = resolved.replace(/[/\\]/g, '_').replace(/^_+/, '');
    const backupPath = path.join(this._backupDir, safeName);

    if (fs.existsSync(resolved)) {
      fs.copyFileSync(resolved, backupPath);
      fs.chmodSync(backupPath, 0o600);
    } else {
      fs.writeFileSync(backupPath, SENTINEL, 'utf8');
      fs.chmodSync(backupPath, 0o600);
    }

    this._backedUp.set(resolved, backupPath);
  }

  /**
   * Restore all backed-up files to their original state.
   * Files that existed before are overwritten with their backup.
   * Files that did NOT exist before are deleted.
   */
  restoreAll() {
    if (this._backedUp.size === 0) return;

    const errors = [];
    for (const [originalPath, backupPath] of this._backedUp) {
      try {
        if (!fs.existsSync(backupPath)) {
          errors.push(`Backup missing for ${originalPath}`);
          continue;
        }
        const content = fs.readFileSync(backupPath, 'utf8');
        if (content === SENTINEL) {
          if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        } else {
          fs.copyFileSync(backupPath, originalPath);
        }
      } catch (err) {
        errors.push(`Failed to restore ${originalPath}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      throw new BackupError(
        'Restore failed for some files:\n' + errors.join('\n') +
        `\nBackup dir preserved at: ${this._backupDir}`
      );
    }
  }

  /** Remove the backup directory securely. */
  cleanup() {
    if (this._backupDir && fs.existsSync(this._backupDir)) {
      // Overwrite backup files with zeros before deleting.
      for (const backupPath of this._backedUp.values()) {
        _secureDelete(backupPath);
      }
      try {
        fs.rmSync(this._backupDir, { recursive: true, force: true });
      } catch {}
    }
    this._backedUp.clear();
    this._backupDir = null;
  }
}

/** Overwrite a file with zeros before unlinking (defense in depth). */
function _secureDelete(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const size = fs.statSync(filePath).size;
    const fd = fs.openSync(filePath, 'w');
    fs.writeSync(fd, Buffer.alloc(size, 0));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort.
  }
}

/**
 * Return the list of Steam VDF files that Shiro may modify.
 * @param {string} steamRoot
 * @returns {string[]}
 */
function getFilesToProtect(steamRoot) {
  const resolved = fs.realpathSync(steamRoot);
  let registryPath = path.join(os.homedir(), '.steam', 'registry.vdf');
  if (!fs.existsSync(registryPath)) {
    registryPath = path.join(resolved, 'registry.vdf');
  }

  return [
    path.join(resolved, 'config', 'loginusers.vdf'),
    path.join(resolved, 'local.vdf'),
    path.join(resolved, 'config', 'config.vdf'),
    registryPath,
  ];
}

module.exports = { SteamBackup, getFilesToProtect, BackupError };
