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

## Packaged installs

Installer builds include `shiro://` protocol metadata.

- **Windows (`.exe`)**: the NSIS installer registers the `shiro://` handler during installation.
- **Linux (`.deb`)**: the Debian package installs a desktop entry with `x-scheme-handler/shiro`, so the handler is registered by the package install.
- **Linux (`.AppImage`)**: the AppImage contains the protocol metadata, but AppImage files do not force desktop integration by themselves. Shiro now writes a local `shiro.desktop` entry on first launch and points it at the actual `.AppImage` file. On Arch and other non-Debian distros this usually works after one manual launch, but **AppImageLauncher** is still the more robust option if your desktop environment ignores local AppImage handlers.

If the protocol association was removed before, launching the packaged app once after reinstall repairs the missing `shiro://` registration on Windows and Linux.

For AppImage users, the easiest flow is usually:

```bash
chmod +x Shiro-*.AppImage
./Shiro-*.AppImage
```

If your system asks whether to integrate the AppImage, choose **yes**. If it does not, install AppImageLauncher or register the desktop file manually.

## Usage

### Register the protocol handler

```bash
npm run register
```

This registers `shiro://` as a custom protocol so your OS can open Shiro when a `shiro://` URL is clicked.

For packaged installs, you usually do **not** need this step on Windows or `.deb`-based Linux systems because the installer handles it already. If the association was removed during an earlier uninstall, start Shiro once after reinstall and it will restore the handler. For AppImage installs, start the AppImage once manually so Shiro can create or refresh its local `shiro.desktop` registration.

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

## Building

### Local packages

Install dependencies first:

```bash
npm install
```

Build release artifacts:

```bash
npm run dist
```

Platform-specific builds:

```bash
npm run dist:linux
npm run dist:win
```

## AUR

The repository contains a ready-to-publish `shiro-bin` AUR package definition in `packaging/aur/shiro-bin`.

It packages the GitHub release AppImage into an Arch package under `/opt/shiro`, installs `/usr/bin/shiro`, the desktop entry, and the icons.

For a local test build on an Arch-based system:

```bash
cd packaging/aur/shiro-bin
makepkg -si
```

When you cut a new release, update `pkgver` in `PKGBUILD` and regenerate `.SRCINFO` with:

```bash
cd packaging/aur/shiro-bin
makepkg --printsrcinfo > .SRCINFO
```

## Uninstall

### 1. Remove the protocol handler

**Linux:**

```bash
for file in ~/.config/mimeapps.list ~/.local/share/applications/mimeapps.list; do
  [ -f "$file" ] && sed -i '/x-scheme-handler\/shiro/d' "$file"
done
rm -f ~/.local/share/applications/shiro.desktop
update-desktop-database ~/.local/share/applications/
```

`xdg-mime` can register a default handler, but it cannot unset one by assigning an empty desktop file. Removing the `x-scheme-handler/shiro` entry from `mimeapps.list` is the reliable way to deregister it.

If you still see `shiro.desktop` in `~/.local/share/applications/mimeinfo.cache`, that file is only a generated cache of available handlers. The actual default association is stored in `mimeapps.list`, and `update-desktop-database ~/.local/share/applications/` rebuilds the cache after the desktop file is removed.

**Windows:** The NSIS uninstaller removes the `shiro://` protocol handler automatically (`HKCU\Software\Classes\shiro`). If needed, you can still remove the key manually via `regedit`.

**Linux package note:** For `.deb` installs, package removal updates the desktop cache automatically. User-level overrides in `~/.config/mimeapps.list` can still remain, so the manual cleanup commands above are still the reliable fallback. After reinstall, launching Shiro once recreates the local `shiro.desktop` mapping if it is missing.

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
