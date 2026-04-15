$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$assetSrc = Join-Path $root "src"
$assetDest = Join-Path $root "app\src\main\assets\taskpad"

Write-Host "Syncing Taskpad web assets into Android app assets..."
Remove-Item -Recurse -Force -LiteralPath $assetDest -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $assetDest | Out-Null
Get-ChildItem -Force -LiteralPath $assetSrc | ForEach-Object {
  Copy-Item -Recurse -Force -Path $_.FullName -Destination $assetDest
}

Write-Host "Android project is ready. Open taskpad-android in Android Studio and build the app."
Write-Host "If you have Gradle and the Android SDK configured, you can run:"
Write-Host "  .\\gradlew.bat assembleDebug"
