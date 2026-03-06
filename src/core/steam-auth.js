/**
 * Steam authentication via steam-session library.
 *
 * Provides an event-driven API for the Electron main process:
 *   - 'authenticated' → { refreshToken }
 *   - 'guard-required' → { type, detail }
 *   - 'error' → Error
 *
 * SECURITY:
 * - Credentials are only used in-memory, never persisted.
 * - Refresh tokens are never logged.
 */

'use strict';

const EventEmitter = require('events');
const {
  LoginSession,
  EAuthTokenPlatformType,
  EAuthSessionGuardType,
  ESessionPersistence,
} = require('steam-session');

class SteamAuth extends EventEmitter {
  constructor() {
    super();
    /** @type {LoginSession | null} */
    this.session = null;
  }

  /**
   * Start the login flow with username and password.
   * Emits 'authenticated' if no guard is needed,
   * or 'guard-required' if a code is required.
   */
  async startLogin(accountName, password) {
    this.session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    this.session.loginTimeout = 300000; // 5 minutes

    this.session.on('authenticated', () => {
      this.emit('authenticated', {
        refreshToken: this.session.refreshToken,
        accessToken: this.session.accessToken,
        accountName: this.session.accountName,
        steamID: this.session.steamID,
      });
    });

    this.session.on('error', (err) => {
      this.emit('error', err);
    });

    this.session.on('timeout', () => {
      this.emit('error', new Error('Authentication timed out'));
    });

    try {
      const result = await this.session.startWithCredentials({
        accountName,
        password,
        persistence: ESessionPersistence.Persistent,
      });

      if (!result.actionRequired) {
        // 'authenticated' event fires automatically.
        return;
      }

      const emailGuard = result.validActions?.find(
        (a) => a.type === EAuthSessionGuardType.EmailCode
      );
      const totpGuard = result.validActions?.find(
        (a) => a.type === EAuthSessionGuardType.DeviceCode
      );
      const deviceConfirm = result.validActions?.find(
        (a) => a.type === EAuthSessionGuardType.DeviceConfirmation
      );

      if (emailGuard) {
        this.emit('guard-required', {
          type: 'email',
          detail: emailGuard.detail || 'unknown',
        });
      } else if (totpGuard) {
        this.emit('guard-required', {
          type: 'totp',
          detail: null,
        });
      } else if (deviceConfirm) {
        this.emit('guard-required', {
          type: 'device_confirm',
          detail: 'Confirm on your Steam mobile app',
        });
      } else {
        const types = result.validActions?.map((a) => a.type).join(', ') || 'unknown';
        this.emit('error', new Error(`Unsupported guard type(s): ${types}`));
      }
    } catch (err) {
      let message = err.message || 'Login failed';
      if (message.includes('RateLimitExceeded')) {
        message = 'Rate limit exceeded – wait 10-30 minutes before retrying';
      } else if (message.includes('InvalidPassword')) {
        message = 'Invalid password';
      }
      this.emit('error', new Error(message));
    }
  }

  /**
   * Submit a Steam Guard code for a pending login.
   * On success, the 'authenticated' event will fire.
   * On failure, the 'error' event will fire (or this method throws).
   */
  async submitGuardCode(code) {
    if (!this.session) throw new Error('No active session');

    try {
      await this.session.submitSteamGuardCode(code.trim());
      // 'authenticated' event fires if the code was correct.
    } catch (err) {
      let message = err.message || 'Code submission failed';
      if (message.includes('InvalidLoginAuthCode')) {
        message = 'Invalid Steam Guard code – try again';
      }
      this.emit('error', new Error(message));
    }
  }

  /** Clean up the session. */
  destroy() {
    if (this.session) {
      this.session.removeAllListeners();
      this.session = null;
    }
    this.removeAllListeners();
  }
}

module.exports = { SteamAuth };
