$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

Write-Host 'Checking shared app runtimes...'
node --check (Join-Path $root 'taskpad-tray\src\app.js')
node --check (Join-Path $root 'taskpad-web\app.js')
node --check (Join-Path $root 'taskpad-android\src\app.js')

Write-Host 'Running tray regression tests...'
Push-Location (Join-Path $root 'taskpad-tray')
try {
  npm.cmd test
}
finally {
  Pop-Location
}

Write-Host 'Taskpad verification passed.'
