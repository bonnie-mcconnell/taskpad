# Taskpad Android Setup

`taskpad-android` now contains a real Android WebView wrapper project plus the shared frontend assets in `src/`.

## What is in this folder
- `src/` - the Taskpad frontend source used by Android
- `app/` - the native Android app module
- `build.gradle.kts`, `settings.gradle.kts`, `gradle.properties` - Android Studio project files
- `build-android.ps1` - syncs `src/` into `app/src/main/assets/taskpad/`

## Before you build
From this folder, run:
```powershell
powershell -ExecutionPolicy Bypass -File .\build-android.ps1
```
This copies the latest Taskpad frontend files into the Android app assets.

## Open in Android Studio
1. Open Android Studio.
2. Choose `Open`.
3. Select the `taskpad-android` folder.
4. Let Android Studio download the Android SDK / Gradle components if prompted.
5. Build or run the `app` module.

## Install on your phone
1. Enable developer mode and USB debugging on your Android phone.
2. Connect the phone to your computer.
3. In Android Studio, choose your device and click `Run`.

Or build an APK from Android Studio:
1. `Build`
2. `Build Bundle(s) / APK(s)`
3. `Build APK(s)`

## Bridge methods already implemented
The native wrapper exposes `window.TaskpadAndroid` with:
- `onStateChanged(String stateJson)`
- `hidePanel()`
- `copyToClipboard(String text)`

The app also calls `window.onTaskpadResume()` on activity resume so sync can refresh.

## config.json
The frontend still reads `src/config.json` before assets are synced.
Set your worker URL there:
```json
{ "workerUrl": "https://your-worker.workers.dev" }
```

## Notes
- A Gradle wrapper is included (`gradlew` / `gradlew.bat`). You can build from the command line without opening Android Studio.
- The simplest path is still to open the folder in Android Studio, which handles SDK provisioning automatically.