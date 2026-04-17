# Build Guide

> **Platform note:** The build and sync scripts (`sync-variants.ps1`, `verify-all.ps1`, `build-android.ps1`) are PowerShell and require Windows. On macOS/Linux, manually copy `taskpad-tray/src/app.js`, `taskpad-tray/src/index.html`, and `taskpad-tray/src/app/sync-core.mjs` into `taskpad-web/` and `taskpad-android/src/` before building those variants.

This repo currently contains three separate Taskpad variants:
- `taskpad-tray` for Windows desktop/tray
- `taskpad-web` for the PWA/web version
- `taskpad-android` for the Android WebView app shell

When you make shared UI/runtime changes in tray, run `./sync-variants.ps1` from the repo root before building web or Android so the variants stay aligned.

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
- set `taskpad-web/config.json` to your Worker URL
- if you update cached assets, bump the cache version in `taskpad-web/sw.js`

## 3. Android
The Android folder now contains a real Android Studio WebView wrapper project plus the shared frontend assets in `taskpad-android/src/`.
Before opening it in Android Studio:
- update `taskpad-android/src/config.json`
- run `powershell -ExecutionPolicy Bypass -File .\taskpad-android\build-android.ps1`
- open `taskpad-android/` in Android Studio and build/run the `app` module

## Shared verification
From the repo root:
```powershell
powershell -ExecutionPolicy Bypass -File .\verify-all.ps1
```
This checks all three JS runtimes and runs the tray sync regression tests.