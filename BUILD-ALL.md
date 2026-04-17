# Build Guide

> **Platform note:** The build and sync scripts (`sync-variants.ps1`, `verify-all.ps1`, `build-android.ps1`) are PowerShell and require Windows. On macOS/Linux, manually copy `taskpad-tray/src/app.js`, `taskpad-tray/src/index.html`, and `taskpad-tray/src/app/sync-core.mjs` into `taskpad-web/` and `taskpad-android/src/` before building those variants, then apply the platform patches described in `sync-variants.ps1` by hand.

This repo contains three Taskpad variants:
- `taskpad-tray` - Windows desktop/tray app (Tauri v2)
- `taskpad-web` - static PWA
- `taskpad-android` - Android WebView wrapper

When you make shared frontend changes in `taskpad-tray/src/`, run `./sync-variants.ps1` from the repo root before building the web or Android variants. The script copies the tray source into the other folders and applies platform-specific patches. If any patch target has changed (e.g. you renamed a function), the script will throw immediately with the name of the failing patch - update `sync-variants.ps1` to match before continuing.

## 1. Desktop / Tray

From `taskpad-tray`:
```powershell
npm install
npm test
npm run build
```
Output installer:
`src-tauri/target/release/bundle/nsis/Taskpad_0.1.0_x64-setup.exe`

## 2. Web

The web app is static. Deploy the contents of `taskpad-web/` to any HTTPS static host.

Before deploying:
- Set `"workerUrl"` in `taskpad-web/config.json` to your Cloudflare Worker URL
- Bump `CACHE_VERSION` in `taskpad-web/sw.js` so returning users get the new assets
- Run `sync-variants.ps1` if you have made any frontend changes since the last sync

## 3. Android

Before opening in Android Studio:
- Set `"workerUrl"` in `taskpad-android/src/config.json`
- Run the build script to copy frontend assets into the Android project:
  ```powershell
  powershell -ExecutionPolicy Bypass -File .\taskpad-android\build-android.ps1
  ```
- Open `taskpad-android/` in Android Studio and build/run the `app` module

## Shared verification

From the repo root:
```powershell
powershell -ExecutionPolicy Bypass -File .\verify-all.ps1
```
This checks all three JS runtimes with `node --check` and runs the tray sync regression tests.
