Continue = 'Stop'
 = 

Write-Host 'Checking shared app runtimes...'
node --check (Join-Path  'taskpad-tray\src\app.js')
node --check (Join-Path  'taskpad-web\app.js')
node --check (Join-Path  'taskpad-android\src\app.js')

Write-Host 'Running tray regression tests...'
Push-Location (Join-Path  'taskpad-tray')
try {
  npm.cmd test
}
finally {
  Pop-Location
}

Write-Host 'Taskpad verification passed.'