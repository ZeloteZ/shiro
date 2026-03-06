/**
 * JWT refresh-token utilities.
 *
 * SECURITY:
 * - Tokens are decoded WITHOUT signature verification (no key needed).
 * - Full token strings are NEVER logged; only derived metadata (SteamID64).
 */

'use strict';

const STEAM_ID64_PATTERN = /^7656119\d{10}$/;
const STEAM_ID_FIELDS = ['sub', 'steamid', 'steam_id', 'steamid64', 'steamId', 'steamId64'];

class TokenError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * Decode the payload of a JWT without signature verification.
 * @param {string} token - A JWT string (header.payload.signature).
 * @returns {object} The decoded payload.
 */
function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new TokenError('Token is not a valid JWT (expected at least 2 dot-separated parts)');
  }

  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload);
  } catch (err) {
    throw new TokenError(`JWT payload decode failed: ${err.message}`);
  }
}

/**
 * Extract the SteamID64 from a Steam JWT refresh token.
 * @param {string} token - A Steam JWT refresh token.
 * @returns {string} The SteamID64 string (e.g. "76561198149379768").
 */
function extractSteamId64(token) {
  const payload = decodeJwtPayload(token);

  for (const field of STEAM_ID_FIELDS) {
    const value = payload[field];
    if (value != null) {
      const steamId = String(value).trim();
      if (STEAM_ID64_PATTERN.test(steamId)) {
        return steamId;
      }
    }
  }

  throw new TokenError(
    `No valid SteamID64 found in token payload (checked fields: ${STEAM_ID_FIELDS.join(', ')})`
  );
}

/**
 * Perform basic structural validation on a token string.
 * @param {string} token - The token to validate.
 */
function validateTokenFormat(token) {
  if (!token || typeof token !== 'string') {
    throw new TokenError('Token must be a non-empty string');
  }
  if (token.length > 4096) {
    throw new TokenError(`Token too long (${token.length} chars, max 4096)`);
  }
  if (token.length < 50) {
    throw new TokenError(`Token too short (${token.length} chars, min 50)`);
  }
  if ((token.match(/\./g) || []).length < 2) {
    throw new TokenError('Token is not a valid JWT (missing dots)');
  }
  if (!token.startsWith('eyA') && !token.startsWith('eyJ')) {
    throw new TokenError('Token does not start with a valid JWT header prefix');
  }
}

module.exports = { decodeJwtPayload, extractSteamId64, validateTokenFormat, TokenError };
