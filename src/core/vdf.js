/**
 * Steam VDF configuration file manipulation.
 *
 * Handles reading/writing of:
 * - loginusers.vdf  (account list, MostRecent, AllowAutoLogin)
 * - local.vdf       (ConnectCache – encrypted tokens, Linux)
 * - config.vdf      (Accounts section)
 * - registry.vdf    (AutoLoginUser, Linux)
 *
 * SECURITY:
 * - File writes use atomic rename (write to temp, then rename) to prevent corruption.
 * - Token hex strings in VDF files are treated as opaque blobs – never logged.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

class VDFError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VDFError';
  }
}

// ---------------------------------------------------------------------------
// CRC32 (standard polynomial 0xEDB88320)
// ---------------------------------------------------------------------------

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c;
}

function crc32(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---------------------------------------------------------------------------
// CRC32 key computation
// ---------------------------------------------------------------------------

/**
 * Compute the ConnectCache VDF key for an account.
 * Format: CRC32(account_name) as 8-digit zero-padded hex + "1" suffix.
 * The original account name case is used for CRC32 (not lowercased).
 * @param {string} accountName
 * @returns {string}
 */
function computeConnectCacheKey(accountName) {
  const c = crc32(accountName);
  return c.toString(16).padStart(8, '0') + '1';
}

// ---------------------------------------------------------------------------
// Atomic file writing
// ---------------------------------------------------------------------------

function _atomicWrite(filePath, content, mode = 0o644) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
}

// ---------------------------------------------------------------------------
// VDF helpers
// ---------------------------------------------------------------------------

function _readVdf(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new VDFError(`VDF file not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Find the byte range of a nested VDF section.
 * @returns {{ start: number, end: number } | null}
 */
function _findSection(text, ...keys) {
  let pos = 0;
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`"${escaped}"[^\\S\\n]*\\n[^\\S\\n]*\\{`, 'i');
    const match = pattern.exec(text.slice(pos));
    if (!match) return null;
    pos += match.index + match[0].length;
  }

  // Find matching closing brace.
  let depth = 1;
  let i = pos;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return { start: pos, end: i };
}

function _findAccountSectionEnd(text, startAfterBrace) {
  let depth = 1;
  let i = startAfterBrace;
  while (i < text.length && depth > 0) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
    i++;
  }
  return depth === 0 ? i : null;
}

// ---------------------------------------------------------------------------
// loginusers.vdf
// ---------------------------------------------------------------------------

/**
 * Update loginusers.vdf to make the given account the active one.
 * Sets MostRecent=1 and AllowAutoLogin=1 for target, MostRecent=0 for others.
 */
function updateLoginusers(steamRoot, username, steamId64, personaName) {
  const filePath = path.join(steamRoot, 'config', 'loginusers.vdf');
  if (!fs.existsSync(filePath)) {
    throw new VDFError(`loginusers.vdf not found at ${filePath}`);
  }

  let content = _readVdf(filePath);

  // Reset all MostRecent to 0.
  content = content.replace(/("MostRecent"\s+)"[^"]*"/g, '$1"0"');

  // Check if account section exists (search by SteamID64).
  const escaped64 = steamId64.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const accountPattern = new RegExp(`"${escaped64}"[^\\S\\n]*\\n[^\\S\\n]*\\{`);
  const match = accountPattern.exec(content);

  if (match) {
    const sectionEnd = _findAccountSectionEnd(content, match.index + match[0].length);
    if (sectionEnd !== null) {
      let sectionText = content.slice(match.index, sectionEnd);

      // Update MostRecent.
      sectionText = sectionText.replace(/("MostRecent"\s+)"[^"]*"/, '$1"1"');

      // Add/update AllowAutoLogin.
      if (sectionText.includes('"AllowAutoLogin"')) {
        sectionText = sectionText.replace(/("AllowAutoLogin"\s+)"[^"]*"/, '$1"1"');
      } else {
        sectionText = sectionText.trimEnd().replace(/\}$/, '').trimEnd();
        sectionText += '\n\t\t"AllowAutoLogin"\t\t"1"\n\t}';
      }

      // Update RememberPassword.
      if (sectionText.includes('"RememberPassword"')) {
        sectionText = sectionText.replace(/("RememberPassword"\s+)"[^"]*"/, '$1"1"');
      }

      // Update PersonaName if provided.
      if (personaName && sectionText.includes('"PersonaName"')) {
        sectionText = sectionText.replace(/("PersonaName"\s+)"[^"]*"/, `$1"${personaName}"`);
      }

      // Always update Timestamp to current time (required for credential freshness).
      const timestamp = Math.floor(Date.now() / 1000);
      if (sectionText.includes('"Timestamp"')) {
        sectionText = sectionText.replace(/("Timestamp"\s+)"[^"]*"/, `$1"${timestamp}"`);
      } else {
        sectionText = sectionText.trimEnd().replace(/\}$/, '').trimEnd();
        sectionText += `\n\t\t"Timestamp"\t\t"${timestamp}"\n\t}`;
      }

      content = content.slice(0, match.index) + sectionText + content.slice(sectionEnd);
    }
  } else {
    // Add new account entry before the final closing brace of "users".
    const timestamp = Math.floor(Date.now() / 1000);
    const newEntry =
      `\t"${steamId64}"\n` +
      `\t{\n` +
      `\t\t"AccountName"\t\t"${username}"\n` +
      `\t\t"PersonaName"\t\t"${personaName || username}"\n` +
      `\t\t"RememberPassword"\t\t"1"\n` +
      `\t\t"MostRecent"\t\t"1"\n` +
      `\t\t"AllowAutoLogin"\t\t"1"\n` +
      `\t\t"Timestamp"\t\t"${timestamp}"\n` +
      `\t}\n`;

    const lastBrace = content.lastIndexOf('}');
    if (lastBrace === -1) {
      throw new VDFError('Malformed loginusers.vdf: no closing brace found');
    }
    content = content.slice(0, lastBrace) + newEntry + content.slice(lastBrace);
  }

  _atomicWrite(filePath, content);
}

// ---------------------------------------------------------------------------
// ConnectCache in local.vdf (Linux)
// ---------------------------------------------------------------------------

/**
 * Read the encrypted ConnectCache token for an account.
 * @returns {string | null} Hex-encoded encrypted token, or null.
 */
function readConnectCache(steamRoot, accountName) {
  const filePath = path.join(steamRoot, 'local.vdf');
  if (!fs.existsSync(filePath)) return null;

  const content = _readVdf(filePath);
  const crcKey = computeConnectCacheKey(accountName);
  const escaped = crcKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`"${escaped}"\\s+"([0-9a-fA-F]+)"`);
  const match = pattern.exec(content);
  return match ? match[1] : null;
}

/**
 * Write an encrypted token to the ConnectCache section of local.vdf.
 * Creates the section if it does not exist.
 */
function writeConnectCache(steamRoot, accountName, encryptedHex) {
  const filePath = path.join(steamRoot, 'local.vdf');
  let content;

  if (!fs.existsSync(filePath)) {
    content =
      '"MachineUserConfigStore"\n' +
      '{\n' +
      '\t"Software"\n' +
      '\t{\n' +
      '\t\t"Valve"\n' +
      '\t\t{\n' +
      '\t\t\t"Steam"\n' +
      '\t\t\t{\n' +
      '\t\t\t\t"ConnectCache"\n' +
      '\t\t\t\t{\n' +
      '\t\t\t\t}\n' +
      '\t\t\t}\n' +
      '\t\t}\n' +
      '\t}\n' +
      '}\n';
  } else {
    content = _readVdf(filePath);
  }

  const crcKey = computeConnectCacheKey(accountName);
  const entryLine = `\t\t\t\t\t"${crcKey}"\t\t"${encryptedHex}"`;

  // Check if the key already exists.
  const escapedKey = crcKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingPattern = new RegExp(`(\\s*"${escapedKey}"\\s+)"[0-9a-fA-F]+"`);
  const existingMatch = existingPattern.exec(content);

  if (existingMatch) {
    content = content.replace(existingPattern, `$1"${encryptedHex}"`);
  } else {
    // Find ConnectCache section and append.
    const ccSection = _findSection(
      content, 'MachineUserConfigStore', 'Software', 'Valve', 'Steam', 'ConnectCache'
    );
    if (ccSection) {
      const insertPos = ccSection.end - 1;
      content = content.slice(0, insertPos) + entryLine + '\n' + content.slice(insertPos);
    } else {
      // ConnectCache section doesn't exist – insert it.
      const steamSection = _findSection(
        content, 'MachineUserConfigStore', 'Software', 'Valve', 'Steam'
      );
      if (steamSection) {
        const insertPos = steamSection.end - 1;
        const ccBlock =
          '\t\t\t\t"ConnectCache"\n' +
          '\t\t\t\t{\n' +
          entryLine + '\n' +
          '\t\t\t\t}\n';
        content = content.slice(0, insertPos) + ccBlock + content.slice(insertPos);
      } else {
        throw new VDFError('Cannot find Steam section in local.vdf to insert ConnectCache');
      }
    }
  }

  _atomicWrite(filePath, content);
}

// ---------------------------------------------------------------------------
// config.vdf – Accounts section
// ---------------------------------------------------------------------------

/**
 * Ensure the Accounts section in config.vdf contains the given account.
 */
function ensureConfigAccounts(steamRoot, username, steamId64) {
  const filePath = path.join(steamRoot, 'config', 'config.vdf');
  if (!fs.existsSync(filePath)) return;

  let content = _readVdf(filePath);

  const escapedUser = username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`"${escapedUser}"[^\\S\\n]*\\n[^\\S\\n]*\\{`).test(content)) {
    return; // Already exists.
  }

  const accountsSection = _findSection(
    content, 'InstallConfigStore', 'Software', 'Valve', 'Steam', 'Accounts'
  );

  if (accountsSection) {
    const insertPos = accountsSection.end - 1;
    const newEntry =
      `\t\t\t\t\t"${username}"\n` +
      `\t\t\t\t\t{\n` +
      `\t\t\t\t\t\t"SteamID"\t\t"${steamId64}"\n` +
      `\t\t\t\t\t}\n`;
    content = content.slice(0, insertPos) + newEntry + content.slice(insertPos);
    _atomicWrite(filePath, content);
  }
}

// ---------------------------------------------------------------------------
// registry.vdf – AutoLoginUser (Linux)
// ---------------------------------------------------------------------------

/**
 * Set the AutoLoginUser in registry.vdf.
 */
function setAutoLoginUser(steamRoot, username) {
  let registryPath = path.join(os.homedir(), '.steam', 'registry.vdf');
  if (!fs.existsSync(registryPath)) {
    registryPath = path.join(steamRoot, 'registry.vdf');
  }
  if (!fs.existsSync(registryPath)) {
    throw new VDFError(`registry.vdf not found at ${registryPath}`);
  }

  let content = _readVdf(registryPath);

  const pattern = /("AutoLoginUser"\s+)"[^"]*"/;
  if (pattern.test(content)) {
    content = content.replace(pattern, `$1"${username}"`);
  } else {
    const steamPattern = /("Steam"\s*\n\s*\{)/;
    const match = steamPattern.exec(content);
    if (match) {
      const insertAfter = match.index + match[0].length;
      content =
        content.slice(0, insertAfter) +
        `\n\t\t\t"AutoLoginUser"\t\t"${username}"` +
        content.slice(insertAfter);
    } else {
      throw new VDFError('Cannot find Steam section in registry.vdf');
    }
  }

  _atomicWrite(registryPath, content);
}

/**
 * Read the current AutoLoginUser from registry.vdf.
 * @returns {string | null}
 */
function getAutoLoginUser(steamRoot) {
  let registryPath = path.join(os.homedir(), '.steam', 'registry.vdf');
  if (!fs.existsSync(registryPath)) {
    registryPath = path.join(steamRoot, 'registry.vdf');
  }
  if (!fs.existsSync(registryPath)) return null;

  const content = _readVdf(registryPath);
  const match = /"AutoLoginUser"\s+"([^"]*)"/.exec(content);
  return match && match[1] ? match[1] : null;
}

module.exports = {
  computeConnectCacheKey,
  readConnectCache,
  writeConnectCache,
  updateLoginusers,
  setAutoLoginUser,
  getAutoLoginUser,
  ensureConfigAccounts,
  VDFError,
};
