

<p align="center">
  <img width="356" height="122" alt="image" src="https://github.com/user-attachments/assets/a6657f17-fd81-4f58-9322-5b5b99dc7ca4" />
</p>


Shiro is an Electron-based companion tool for [Kuroi](https://github.com/illumfx/kuroi) that enables one-click Steam account switching on Linux.

> [!NOTE]
> Shiro is mostly vibe-coded and may be unstable.

## How it works

1. Kuroi sends a `shiro://login?token=XXX&api=http://...` URL
2. Shiro fetches encrypted credentials from the Kuroi backend (one-time token)
3. Authenticates via [steam-session](https://www.npmjs.com/package/steam-session)
4. If Steam Guard is required → shows input in GUI
5. Logs in via **CEF Remote Debugging** (primary) or **VDF injection** (fallback)
6. Restarts Steam → auto-closes

## Features

- **CEF Remote Debugging** – Calls `SteamClient.Auth.SetLoginToken()` directly via Chrome DevTools Protocol (no file manipulation needed)
- **VDF Injection Fallback** – Writes encrypted tokens to Steam's VDF config files when CEF is unavailable
- **Steam Guard Support** – Email codes, TOTP (mobile authenticator), and device confirmation
- **Atomic File Writes** – VDF modifications use atomic rename to prevent corruption
- **Backup & Restore** – All modified files are backed up before changes; restored on failure
- **Secure Cleanup** – Backup files are zeroed out before deletion

## Requirements

- **Linux** (Steam path detection is Linux-only)
- **Node.js** ≥ 18
- **Steam** installed locally
- **Kuroi** backend for credential management

## Installation

```bash
git clone https://github.com/ZeloteZ/shiro.git
cd shiro
npm install
```

## Usage

### Register the protocol handler

```bash
npm run register
```

This registers `shiro://` as a custom protocol so your OS can open Shiro when a `shiro://` URL is clicked.

If the automatic registration does not work, you can manually create a Desktop Entry. Create the file `~/.local/share/applications/shiro.desktop` with the following content:

```ini
[Desktop Entry]
Name=Shiro
Comment=Steam One-Click Login Tool
Exec=/path/to/shiro/node_modules/electron/dist/electron /path/to/shiro %u
Type=Application
MimeType=x-scheme-handler/shiro;
NoDisplay=true
```

> **Note:** Replace `/path/to/shiro` with the actual path to your Shiro installation.

Then register it and update the desktop database:

```bash
xdg-mime default shiro.desktop x-scheme-handler/shiro
update-desktop-database ~/.local/share/applications/
```

### Start Shiro

Shiro is typically launched via a `shiro://` URL from Kuroi. To start it manually:

```bash
npm start
```

Shiro will sit in the system tray, waiting for a login request.

### Custom Steam path

If Steam is installed in a non-standard location, set the `STEAM_ROOT` environment variable:

```bash
STEAM_ROOT=/path/to/steam npm start
```

## Security

- Credentials are **never** persisted to disk by Shiro – only held in memory during the login flow
- Login tokens are fetched via **one-time tokens** that expire after use
- VDF backup files are **securely wiped** (overwritten with zeros) before deletion
- Backup directories use **restricted permissions** (0700)
- Electron uses **context isolation**, **disabled node integration**, and a strict **Content Security Policy**

## Uninstall

### 1. Remove the protocol handler

```bash
xdg-mime default '' x-scheme-handler/shiro
```

Then delete the desktop entry (if created by Electron):

```bash
rm -f ~/.local/share/applications/shiro-handler.desktop
update-desktop-database ~/.local/share/applications/
```

### 2. Remove the CEF debugging marker (if it exists)

Shiro creates a `.cef-enable-remote-debugging` file in your Steam directory to enable CEF remote debugging. Remove it if you no longer need it:

```bash
rm -f ~/.local/share/Steam/.cef-enable-remote-debugging
```

### 3. Delete Shiro

```bash
rm -rf /path/to/shiro
```

No system-wide files, services, or daemons are installed. All Shiro data (logs, backups) is stored within the project directory and cleaned up automatically.


## License

[MIT](LICENSE)
