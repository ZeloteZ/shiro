

<p align="center">
  <img width="356" height="122" alt="image" src="https://github.com/user-attachments/assets/a6657f17-fd81-4f58-9322-5b5b99dc7ca4" />
</p>


Shiro is an Electron-based companion tool for [Kuroi](https://github.com/illumfx/kuroi) that enables one-click Steam account switching on Linux and Windows.

> [!NOTE]
> Shiro is mostly vibe-coded and may be unstable.

## How it works

1. Kuroi sends a `shiro://login?token=XXX&api=http://...` URL
2. Shiro fetches encrypted credentials from the Kuroi backend (one-time token)
3. Authenticates via [steam-session](https://www.npmjs.com/package/steam-session)
4. If Steam Guard is required → shows input in GUI
5. Logs in via **CEF Remote Debugging**
6. Restarts Steam → auto-closes

## Features

- **CEF Remote Debugging** – Calls `SteamClient.Auth.SetLoginToken()` directly via Chrome DevTools Protocol (no file manipulation needed)
- **Steam Guard Support** – Email codes, TOTP (mobile authenticator), and device confirmation

## Requirements

- **Linux** or **Windows**
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

If the automatic registration does not work on Linux, you can manually create a Desktop Entry. Create the file `~/.local/share/applications/shiro.desktop` with the following content:

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

On **Windows**, `npm run register` writes the `shiro://` handler to the Windows Registry automatically. No manual steps needed.

### Start Shiro

Shiro is typically launched via a `shiro://` URL from Kuroi. To start it manually:

```bash
npm start
```

Shiro will sit in the system tray, waiting for a login request.

### Custom Steam path

If Steam is installed in a non-standard location, set the `STEAM_ROOT` environment variable:

**Linux:**
```bash
STEAM_ROOT=/path/to/steam npm start
```

**Windows (PowerShell):**
```powershell
$env:STEAM_ROOT="C:\path\to\Steam"; npm start
```

## Uninstall

### 1. Remove the protocol handler

**Linux:**
```bash
xdg-mime default '' x-scheme-handler/shiro
rm -f ~/.local/share/applications/shiro-handler.desktop
update-desktop-database ~/.local/share/applications/
```

**Windows:** The `shiro://` protocol handler is stored in the Windows Registry under `HKCU\Software\Classes\shiro`. It is removed automatically when uninstalling Electron, or you can delete the key manually via `regedit`.

### 2. Remove the CEF debugging marker (if it exists)

Shiro creates a `.cef-enable-remote-debugging` file in your Steam directory to enable CEF remote debugging. Remove it if you no longer need it:

**Linux:**
```bash
rm -f ~/.local/share/Steam/.cef-enable-remote-debugging
```

**Windows:**
```powershell
Remove-Item "$env:ProgramFiles\Steam\.cef-enable-remote-debugging" -ErrorAction SilentlyContinue
Remove-Item "${env:ProgramFiles(x86)}\Steam\.cef-enable-remote-debugging" -ErrorAction SilentlyContinue
```

### 3. Delete Shiro

```bash
rm -rf /path/to/shiro
```

No system-wide files, services, or daemons are installed. All Shiro data (logs) is stored within the project directory and cleaned up automatically.

## Security

- Credentials are **never** persisted to disk by Shiro – only held in memory during the login flow
- Login tokens are fetched via **one-time tokens** that expire after use
- Electron uses **context isolation**, **disabled node integration**, and a strict **Content Security Policy**

## License

[MIT](LICENSE)
