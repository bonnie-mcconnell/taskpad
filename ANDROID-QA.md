# Android QA Checklist

Run this before publishing or sharing a new Android APK.

## Build

```powershell
cd taskpad-android
.\gradlew.bat assembleDebug
```

Install:
```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

## Sync

- Fresh install opens the setup screen when no local key exists.
- Existing sync key connects without "No worker URL configured".
- Pull from another device appears after reopening the Android app.
- Add/edit/delete on Android syncs back to tray or web.
- Real Worker URL only exists in ignored `config.local.json`, never committed.

## Core Touch Flow

- Tap checkbox: marks a task done without opening the keyboard.
- Tap priority symbol: cycles must/should/could without opening the keyboard.
- Double tap task text: opens edit mode and shows the keyboard.
- Single tap task text: does nothing except normal row feedback.
- Submit a new task: task appears, sync starts, keyboard dismisses on Android.

## Reorder

- Long press an unfinished task until drag starts.
- Drag within the same section and release between tasks.
- Drag into another section and release.
- Drag near the top/bottom of the list and confirm auto-scroll works.
- Done tasks do not start drag.

## Delete / Undo

- Slow vertical scroll does not trigger swipe delete.
- Short accidental horizontal movement snaps back.
- Deliberate left swipe past halfway deletes the task.
- Undo restores the task in the expected section.

## Regression Notes

- Tray app still supports mouse drag/drop.
- Web mobile uses the Android touch gestures.
- Desktop web/tray still uses click-to-edit.
