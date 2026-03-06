/**
 * Steam ConnectCache encryption / decryption.
 *
 * Algorithm (reverse-engineered from steamclient.so CCrypto::SymmetricEncrypt):
 *   1. key = SHA-256(account_name)              → 32 bytes (AES-256)
 *   2. iv  = crypto.randomBytes(16)             → 16 random bytes
 *   3. block_0 = AES-ECB-encrypt(iv, key)       → encrypted IV
 *   4. blocks  = AES-256-CBC(token + PKCS7, key, iv)
 *   5. output  = hex(block_0 ‖ blocks)
 *
 * SECURITY:
 * - Token values are NEVER logged.
 * - Encryption keys are derived per-account and discarded after use.
 * - Random IVs from crypto.randomBytes (kernel CSPRNG).
 */

'use strict';

const crypto = require('crypto');

const AES_BLOCK_BYTES = 16;

class CryptoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Derive AES-256 key from account name via SHA-256.
 * Steam's ConnectCache_Writer/Reader apply tolower() to the account name
 * before passing it to CCrypto::GenerateSHA256Digest (confirmed via RE of
 * steamclient.so at 0x17616ae / 0x1761c10).
 * CRC32 key uses ORIGINAL case – only the SHA-256 key is lowercased.
 */
function _deriveKey(accountName) {
  return crypto.createHash('sha256').update(accountName.toLowerCase(), 'utf8').digest();
}

/** Encrypt a single 16-byte block with AES-ECB (no padding). */
function _aesEcbEncryptBlock(key, block) {
  const cipher = crypto.createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Decrypt a single 16-byte block with AES-ECB (no padding). */
function _aesEcbDecryptBlock(key, block) {
  const decipher = crypto.createDecipheriv('aes-256-ecb', key, null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(block), decipher.final()]);
}

/**
 * Encrypt a JWT refresh token for Steam's ConnectCache on Linux.
 * @param {string} accountName - Steam account name.
 * @param {string} token - JWT refresh token.
 * @returns {string} Hex-encoded ciphertext ready for local.vdf.
 */
function encryptConnectCache(accountName, token) {
  if (!accountName) throw new CryptoError('accountName must not be empty');
  if (!token) throw new CryptoError('token must not be empty');

  try {
    const key = _deriveKey(accountName);
    const iv = crypto.randomBytes(AES_BLOCK_BYTES);

    // Block 0: IV encrypted with AES-ECB (Steam's non-standard IV storage).
    const encryptedIv = _aesEcbEncryptBlock(key, iv);

    // Blocks 1–N: AES-256-CBC with PKCS#7 padding (Node.js auto-pads).
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);

    return Buffer.concat([encryptedIv, ciphertext]).toString('hex');
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError(`Encryption failed: ${err.message}`);
  }
}

/**
 * Decrypt a ConnectCache token from local.vdf.
 * @param {string} accountName - Steam account name.
 * @param {string} encryptedHex - Hex-encoded encrypted token.
 * @returns {string} The plaintext JWT refresh token.
 */
function decryptConnectCache(accountName, encryptedHex) {
  if (!accountName) throw new CryptoError('accountName must not be empty');
  if (!encryptedHex) throw new CryptoError('encryptedHex must not be empty');

  let data;
  try {
    data = Buffer.from(encryptedHex, 'hex');
  } catch {
    throw new CryptoError('Invalid hex encoding in encrypted token');
  }

  if (data.length < AES_BLOCK_BYTES * 2) {
    throw new CryptoError(`Encrypted data too short (${data.length} bytes, minimum ${AES_BLOCK_BYTES * 2})`);
  }
  if (data.length % AES_BLOCK_BYTES !== 0) {
    throw new CryptoError(`Encrypted data length (${data.length}) is not a multiple of AES block size`);
  }

  try {
    const key = _deriveKey(accountName);

    // Block 0 → recover the original random IV.
    const iv = _aesEcbDecryptBlock(key, data.subarray(0, AES_BLOCK_BYTES));

    // Blocks 1–N → AES-256-CBC decrypt (Node.js auto-unpads PKCS#7).
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([
      decipher.update(data.subarray(AES_BLOCK_BYTES)),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError(`Decryption failed: ${err.message}`);
  }
}

module.exports = { encryptConnectCache, decryptConnectCache, CryptoError };
