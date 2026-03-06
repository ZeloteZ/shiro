/**
 * Shiro file logger.
 * Writes timestamped log entries to shiro.log in the app directory.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'shiro.log');

function _ts() {
  return new Date().toISOString();
}

function _write(level, ...args) {
  const msg = args.map(a =>
    a instanceof Error ? `${a.message}\n${a.stack}` :
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ');
  const line = `[${_ts()}] [${level}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch {}
  // Also print to stderr for terminal visibility.
  process.stderr.write(line);
}

const log = {
  info: (...args) => _write('INFO', ...args),
  warn: (...args) => _write('WARN', ...args),
  error: (...args) => _write('ERROR', ...args),
  debug: (...args) => _write('DEBUG', ...args),
  /** Clear log file at startup. */
  clear() {
    try { fs.writeFileSync(LOG_PATH, `=== Shiro log started at ${_ts()} ===\n`, 'utf8'); } catch {}
  },
  get path() { return LOG_PATH; },
};

module.exports = log;
