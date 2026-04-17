# Taskpad

A notebook-style task list I built because every todo app I tried was either too heavy to have open all day or too basic to actually organise anything. Lives in the Windows system tray (one click away from any app), works as a PWA on mobile, and has an Android wrapper - all running the same frontend, synced through a Cloudflare Worker you deploy yourself.

<img width="1920" height="1080" alt="Screenshot (1611)" src="https://github.com/user-attachments/assets/332c30ad-4912-4953-a801-a77e735d979c" />
<img width="1920" height="1080" alt="Screenshot (1613)" src="https://github.com/user-attachments/assets/2af8603f-7889-49e8-9865-dd9f44521926" />


## What it does

Three priority levels - must, should, could - with a hard cap of three "must" tasks per day. The cap is the point: it forces the question of what actually has to happen today. Drag to reorder on desktop, swipe to delete on mobile, particle burst + confetti when you complete all your musts or clear the whole list.

Sync is opt-in and offline-first. The app works fully without it; enabling it requires deploying your own Cloudflare Worker (instructions below). Conflict detection is last-write-wins with a `updatedAt` timestamp - if two devices diverge, you get a dialog asking which version to keep rather than a silent overwrite.

## Structure

| Folder | What it is |
|---|---|
| `taskpad-tray` | Tauri v2 desktop app - Windows system tray panel |
| `taskpad-web` | Static PWA - deploy to any HTTPS host |
| `taskpad-android` | Android Studio project - WebView wrapper with native bridge |

The three variants share one frontend (`app.js`, `index.html`, `sync-core.mjs`). `sync-variants.ps1` copies the tray source into the web and Android folders and applies platform-specific patches (swipe vs drag, PWA manifest injection, Android bridge wiring). Run it from the repo root after any shared frontend change.

## Building

Full instructions: [BUILD-ALL.md](BUILD-ALL.md)

Quick start - tray app:
```powershell
cd taskpad-tray
npm install
npm test
npm run build
```

The installer lands at `taskpad-tray/src-tauri/target/release/bundle/nsis/Taskpad_0.1.0_x64-setup.exe`.

## Sync setup

Sync requires your own Cloudflare Worker. There is no shared default endpoint.

1. Deploy a Worker that handles `GET /tasks` and `PUT /tasks` with Bearer token auth (the sync key is a 64-character hex string the app generates)
2. Set `"workerUrl"` in `config.json` inside each variant folder you use
3. Update `connect-src` in `taskpad-tray/src-tauri/tauri.conf.json` if your Worker is not on a `*.workers.dev` domain

The app generates sync keys locally - nothing is sent to any third party.

## What was hard to build

**Tray positioning on Windows.** `SPI_GETWORKAREA` only returns the primary monitor's work area, so on a multi-monitor setup where the taskbar is on a secondary screen the panel would appear partially behind it. The fix is `GetMonitorInfoW` with the `HMONITOR` containing the cursor, which gives the correct work area rect per monitor. See `position_and_show` in `taskpad-tray/src-tauri/src/lib.rs`.

**Trackpad scroll in WebView2.** Windows WebView2 uses DirectManipulation, which can intercept trackpad scroll events before they reach the DOM. The fix is a capturing `wheel` listener injected via Tauri's `initialization_script` that walks the DOM to find the scrollable container and applies the delta manually.

**Skip-taskbar on Windows with always-on-top.** Tauri's `skip_taskbar()` is not always respected when `always_on_top` is also set. The fix is setting `WS_EX_TOOLWINDOW` and clearing `WS_EX_APPWINDOW` directly on the HWND via Win32. See `set_tool_window` in `lib.rs`.

**Sync conflict without data loss.** When a push detects the remote `updatedAt` is ahead of the last known sync point, the conflicting state is written to `localStorage` before showing the dialog, so neither version is lost regardless of what the user chooses.

## What I would do differently

The string-patching approach in `sync-variants.ps1` is fragile - it relies on exact source text staying stable. A better design would inject platform capability flags at build time and branch on them in a single shared file, eliminating the copy-and-patch step entirely. I added `Assert-Patched` guards so mismatches throw immediately instead of silently producing a broken build, but the underlying architecture is still a shortcut.

`app.js` is 1,600 lines in a single IIFE. It's readable because the sections are clearly delimited, but there are no module boundaries between state management, sync, drag-and-drop, and animation. Fine for a personal tool; wrong for anything that would need to grow.

The build scripts are PowerShell-only, which means macOS/Linux users need to manually copy files instead of running a script. A cross-platform build step (a small Node script or a Makefile) would fix this.

## Platform notes

- **Windows:** tested on Windows 11, WebView2 runtime required (ships with Windows 10/11)
- **Android:** tested on Android 12+; WebView version must support ES modules
- **Web/PWA:** any modern browser; `install` prompt appears on Chrome/Edge/Android Chrome

## License

Personal use. Not published as a general-purpose tool.
