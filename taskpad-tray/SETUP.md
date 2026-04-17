# Taskpad - Windows Tray App

## What this does

A native Windows system tray application. Taskpad lives in your system tray
(bottom-right of the taskbar) permanently. Click the icon -> panel slides open.
Click anywhere else -> panel closes. Works from any app -> Word, games, anything.
Starts with Windows automatically.

## Prerequisites

Install these once on your Windows machine:

### 1. Rust
https://rustup.rs - run the installer, accept defaults.
Restart your terminal after.

### 2. Node.js
https://nodejs.org - LTS version.

### 3. Tauri prerequisites (Windows)
Tauri needs the Microsoft C++ Build Tools and WebView2.
WebView2 is already on Windows 10/11. For Build Tools:
https://tauri.app/start/prerequisites/#windows

Quick check - run this in PowerShell:
```powershell
rustc --version    # should print rustc 1.7x.x
cargo --version    # should print cargo 1.7x.x
node --version     # should print v18+ or v20+
```

---

## Project setup

### 1. Copy your taskpad files into place

Your project structure should look like this:
```
taskpad-tray/
|- package.json
|- src/
|  \- index.html          <- the app UI
\- src-tauri/
   |- Cargo.toml
   |- tauri.conf.json
   |- capabilities/
   |  \- default.json
   |- icons/               <- generated, already present
   \- src/
      |- main.rs
      \- lib.rs
```

### 2. Set your Worker URL in `src/config.json`

Edit:
```json
{
  "workerUrl": "https://your-worker.workers.dev"
}
```
Leave it empty (`""`) to run without sync. If you use a custom domain instead of
`*.workers.dev`, also update `connect-src` in `src-tauri/tauri.conf.json`.

### 3. Install npm dependencies
```powershell
cd taskpad-tray
npm install
```

### 4. Run in development mode
```powershell
npm run dev
```
This compiles the Rust code (first time takes 2-5 minutes) and opens
the panel. The tray icon appears. Test everything works.

### 5. Run the regression check
```powershell
npm test
```
This runs the sync regression tests for key validation, error classification,
conflict handling helpers, and the Worker URL resolver.

### 6. Build for production
```powershell
npm run build
```
Produces an installer in:
`src-tauri/target/release/bundle/nsis/Taskpad_0.1.0_x64-setup.exe`

Run that installer. Taskpad is now installed. It will appear in your
system tray immediately and start automatically on login.

---

## How the tray app behaves

| Action | Result |
|--------|--------|
| Left-click tray icon | Open / close panel |
| Right-click tray icon | Context menu |
| Context menu -> Open | Open panel |
| Context menu -> Start on login | Toggle Windows autostart |
| Context menu -> Quit | Exit completely |
| Click outside panel | Panel closes |
| Press Escape | Panel closes |
| Drag binding strip | Move panel to preferred corner |

## Panel position

The panel appears above the system tray, right-aligned. If you move it by
dragging the dark binding strip at the top, Taskpad now remembers that
position between launches and restores it on open.

---

## Troubleshooting

**"error: linker `link.exe` not found"**
-> Install Microsoft C++ Build Tools (link in prerequisites above).

**Panel appears in the wrong position**
-> If your taskbar is on the left/top/right instead of the bottom,
   the positioning heuristic may be slightly off. Edit the
   `position_and_show` function in `src-tauri/src/lib.rs` to adjust the
   x/y calculation for your setup.

**"WebView2 not found"**
-> Download and install WebView2 runtime from Microsoft:
   https://developer.microsoft.com/en-us/microsoft-edge/webview2/

**Fonts don't load (no internet)**
-> Run `node download-fonts.mjs` once. That writes `src/fonts/` and
   `src/fonts.css`, which the tray app will automatically use instead of the
   Google Fonts URL when those files are present.
