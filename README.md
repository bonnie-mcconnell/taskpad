# Taskpad

A notebook-style task manager I built for myself. Lives in the Windows system tray, works as a PWA on mobile, and has an Android app wrapper - all running the same frontend, synced via a Cloudflare Worker.

![screenshot or gif here]

## What it is

Three-priority task list (must / should / could) with a hard cap of 3 "must" tasks per day. Drag to reorder, swipe to delete on mobile, celebration animations when you hit milestones, and a sync layer that handles conflict detection across devices.

## Structure

| Folder | What it is |
|---|---|
| `taskpad-tray` | Tauri v2 app - system tray panel for Windows |
| `taskpad-web` | Static PWA - deploy to any HTTPS host |
| `taskpad-android` | Android Studio project - WebView wrapper |

The three variants share a single frontend. `sync-variants.ps1` patches platform-specific behaviour into the web and Android copies from the tray source.

## Building

See [BUILD-ALL.md](BUILD-ALL.md) for full instructions.

Quick start (tray app):
```powershell
cd taskpad-tray
npm install
npm test
npm run build
```

## Sync

Sync is opt-in via a Cloudflare Worker. The app works fully offline without it. To use sync, deploy your own Worker and set the URL in `config.json` in each variant's folder.

## Why I built it

I wanted the same task list everywhere I actually use it, with the tray version always one click away and the must/should/could structure keeping my day small enough to finish.
