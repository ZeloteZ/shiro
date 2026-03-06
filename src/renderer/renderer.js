/**
 * Shiro 白 – Renderer logic.
 * Listens for IPC status updates and manages the GUI state.
 */

'use strict';

// DOM elements
const spinner = document.getElementById('spinner');
const successIcon = document.getElementById('success-icon');
const errorIcon = document.getElementById('error-icon');
const idleIcon = document.getElementById('idle-icon');
const statusText = document.getElementById('status-text');
const guardArea = document.getElementById('guard-area');
const guardPrompt = document.getElementById('guard-prompt');
const guardCode = document.getElementById('guard-code');
const guardSubmit = document.getElementById('guard-submit');
const errorActions = document.getElementById('error-actions');
const closeBtn = document.getElementById('close-btn');
const closeErrorBtn = document.getElementById('close-error-btn');

// Current state for guard retry
let currentGuardType = null;

// ---------------------------------------------------------------------------
// Status update handler
// ---------------------------------------------------------------------------

const LOADING_STATES = new Set([
  'fetching', 'authenticating', 'submitting', 'injecting',
  'restarting', 'waiting', 'restoring',
]);

window.shiro.onStatus((data) => {
  const { status, message, guardType, guardDetail } = data;

  // Update status text.
  statusText.textContent = message || '';
  statusText.className = 'status-text';

  // Hide everything first.
  spinner.style.display = 'none';
  successIcon.style.display = 'none';
  errorIcon.style.display = 'none';
  idleIcon.style.display = 'none';
  guardArea.style.display = 'none';
  errorActions.style.display = 'none';

  if (LOADING_STATES.has(status)) {
    // Loading state – show spinner.
    spinner.style.display = 'block';
  } else if (status === 'guard' || status === 'guard_error') {
    // Guard code required – show input.
    currentGuardType = guardType || currentGuardType;
    spinner.style.display = 'none';
    guardArea.style.display = 'flex';

    if (currentGuardType === 'device_confirm') {
      // No input needed – just waiting for mobile confirmation.
      guardPrompt.textContent = message;
      guardCode.style.display = 'none';
      guardSubmit.style.display = 'none';
      spinner.style.display = 'block';
    } else {
      guardCode.style.display = 'block';
      guardSubmit.style.display = 'block';
      guardPrompt.textContent = status === 'guard_error'
        ? '❌ ' + message
        : message;

      // Configure input based on guard type.
      if (currentGuardType === 'totp') {
        guardCode.placeholder = '000000';
        guardCode.maxLength = 6;
      } else {
        guardCode.placeholder = 'A1B2C';
        guardCode.maxLength = 8;
      }

      if (status === 'guard_error') {
        guardCode.value = '';
        guardCode.classList.add('error-flash');
        setTimeout(() => guardCode.classList.remove('error-flash'), 600);
      }

      guardCode.focus();
    }
  } else if (status === 'done') {
    // Success!
    successIcon.style.display = 'block';
    statusText.classList.add('success');
  } else if (status === 'error') {
    // Error.
    errorIcon.style.display = 'block';
    statusText.classList.add('error');
    errorActions.style.display = 'block';
  } else if (status === 'idle') {
    // Idle / ready.
    idleIcon.style.display = 'block';
  }
});

// ---------------------------------------------------------------------------
// Guard code input
// ---------------------------------------------------------------------------

guardCode.addEventListener('input', () => {
  // Enable/disable submit button.
  guardSubmit.disabled = !guardCode.value.trim();
});

guardCode.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && guardCode.value.trim()) {
    submitGuardCode();
  }
});

guardSubmit.addEventListener('click', () => {
  submitGuardCode();
});

function submitGuardCode() {
  const code = guardCode.value.trim().toUpperCase();
  if (!code) return;

  guardSubmit.disabled = true;
  guardCode.disabled = true;

  window.shiro.submitGuardCode(code);

  // Re-enable after a short delay (in case of error, user can retry).
  setTimeout(() => {
    guardCode.disabled = false;
    guardSubmit.disabled = !guardCode.value.trim();
  }, 2000);
}

// ---------------------------------------------------------------------------
// Close buttons
// ---------------------------------------------------------------------------

closeBtn.addEventListener('click', () => {
  window.shiro.close();
});

closeErrorBtn.addEventListener('click', () => {
  window.shiro.close();
});
