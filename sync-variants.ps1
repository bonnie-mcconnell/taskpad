$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$traySrc = Join-Path $root 'taskpad-tray\src'
$webRoot = Join-Path $root 'taskpad-web'
$androidSrc = Join-Path $root 'taskpad-android\src'
$nl = [Environment]::NewLine

function Write-Utf8NoBom {
  param([string]$Path, [string]$Content)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Load-Text {
  param([string]$Path)
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::ReadAllText($Path, $encoding)
}

# Assert-Patched: verifies that a string replacement actually changed the content.
# Throws immediately if the old string was not found - prevents silent patch failures
# when the tray source changes and a patch target no longer matches.
function Assert-Patched {
  param([string]$Before, [string]$After, [string]$PatchName)
  if ($Before -eq $After) {
    throw "Patch '$PatchName' did not match - the tray source may have changed. Update sync-variants.ps1 to match."
  }
}

Write-Host 'Syncing shared runtime from tray...'
Copy-Item -LiteralPath (Join-Path $traySrc 'app.js') -Destination (Join-Path $webRoot 'app.js') -Force
Copy-Item -LiteralPath (Join-Path $traySrc 'app\sync-core.mjs') -Destination (Join-Path $webRoot 'app\sync-core.mjs') -Force
Copy-Item -LiteralPath (Join-Path $traySrc 'index.html') -Destination (Join-Path $webRoot 'index.html') -Force
Copy-Item -LiteralPath (Join-Path $traySrc 'app.js') -Destination (Join-Path $androidSrc 'app.js') -Force
Copy-Item -LiteralPath (Join-Path $traySrc 'app\sync-core.mjs') -Destination (Join-Path $androidSrc 'app\sync-core.mjs') -Force
Copy-Item -LiteralPath (Join-Path $traySrc 'index.html') -Destination (Join-Path $androidSrc 'index.html') -Force

Write-Host 'Patching web runtime behavior...'
$webAppPath = Join-Path $webRoot 'app.js'
$webApp = Load-Text $webAppPath
$before = $webApp
$webApp = $webApp.Replace('    li.classList.toggle(''reorderable'', !task.done && !isAndroid);', '    li.classList.toggle(''reorderable'', !task.done && !isAndroid && !isMobile);')
Assert-Patched $before $webApp 'web: reorderable-toggleDone'
$oldWebDrag = @(
  '    // Drag and drop - desktop-only (mouse events, not touch/pointer)',
  '    if (!task.done && !isAndroid) {',
  '      setupDrag(li, task.id);',
  '    }',
  '    // Swipe-to-delete: Android only',
  '    if (isAndroid) setupSwipe(li, task.id);'
) -join $nl
$newWebDrag = @(
  '    // Drag and drop - desktop browsers only (not mobile/Android)',
  '    if (!task.done && !isAndroid && !isMobile) {',
  '      setupDrag(li, task.id);',
  '    }',
  '    // Swipe-to-delete: Android and mobile web browsers',
  '    if (isAndroid || isMobile) setupSwipe(li, task.id);'
) -join $nl
$before = $webApp
$webApp = $webApp.Replace($oldWebDrag, $newWebDrag)
Assert-Patched $before $webApp 'web: drag setup block'
$before = $webApp
$webApp = $webApp.Replace('    if (isAndroid && state.tasks.length > 0 && !localStorage.getItem(SWIPE_SHOWN)) {', '    if ((isAndroid || isMobile) && state.tasks.length > 0 && !localStorage.getItem(SWIPE_SHOWN)) {')
Assert-Patched $before $webApp 'web: swipe hint render()'
$before = $webApp
$webApp = $webApp.Replace('    if (isAndroid && !localStorage.getItem(SWIPE_SHOWN)) {', '    if ((isAndroid || isMobile) && !localStorage.getItem(SWIPE_SHOWN)) {')
Assert-Patched $before $webApp 'web: swipe hint addTask()'
$before = $webApp
$webApp = $webApp.Replace('    li.classList.toggle(''reorderable'', !checked && !isAndroid);', '    li.classList.toggle(''reorderable'', !checked && !isAndroid && !isMobile);')
Assert-Patched $before $webApp 'web: reorderable-toggleDone2'
$before = $webApp
$webApp = $webApp.Replace('  if (isAndroid) {' + $nl + "    footerHint.textContent = 'tap text to edit · tap ★ to reprioritise · swipe to delete';", '  if (isAndroid || isMobile) {' + $nl + "    footerHint.textContent = 'tap text to edit · tap ★ to reprioritise · swipe to delete';")
Assert-Patched $before $webApp 'web: footer hint'
Write-Utf8NoBom $webAppPath $webApp

Write-Host 'Patching web shell...'
$webIndexPath = Join-Path $webRoot 'index.html'
$webIndex = Load-Text $webIndexPath
$webIndex = $webIndex.Replace('  <meta name="theme-color" content="#fdf6ec">' + $nl + '  <!-- manifest and apple-touch-icon are web/PWA only - not present in tray build -->', '  <meta name="theme-color" content="#fdf6ec">' + $nl + '  <link rel="manifest" href="manifest.json">' + $nl + '  <link rel="apple-touch-icon" href="icon-192.png">')
$webIndex = $webIndex.Replace((@(
  '  <!--',
  '    Fonts: run `node download-fonts.mjs` once to bundle fonts locally (offline use).',
  '    That creates src/fonts/ and src/fonts.css. The app detects this automatically.',
  '  -->'
) -join $nl), '  <!-- Fonts: run `node download-fonts.mjs` once to bundle fonts locally for offline PWA use -->')
$webIndex = $webIndex.Replace((@(
  '    /* ── Tauri panel overrides ── */',
  '    html.tauri-panel { border: 1px solid var(--rule-dark); border-radius: 4px; overflow: hidden; }',
  '    html.tauri-panel .app { height: 100vh; max-height: 100vh; overflow: hidden; }',
  '    html.tauri-panel .binding { -webkit-app-region: drag; cursor: grab; }',
  '    html.tauri-panel .binding * { -webkit-app-region: no-drag; }',
  '    html.tauri-panel .header,',
  '    html.tauri-panel .footer,',
  '    html.tauri-panel .section-header,',
  '    html.tauri-panel .add-priority { user-select: none; -webkit-user-select: none; }'
) -join $nl), (@(
  '    /* ── Web / PWA ── */',
  '    @media (max-width: 400px) { :root { --margin-left: 36px; } }',
  '    @media (display-mode: standalone) {',
  '      .app { padding-bottom: env(safe-area-inset-bottom, 0); }',
  '    }'
) -join $nl))
$webIndex = [regex]::Replace($webIndex, '<script>\s*\(\(\) => \{\s*if \(typeof window\.__TAURI__ === ''undefined''\) return;[\s\S]*?</script>\s*', '')
$webIndex = [regex]::Replace($webIndex, '<script>\s*\(\(\) => \{\s*if \(typeof window\.TaskpadAndroid === ''undefined''\) return;[\s\S]*?</script>\s*', '')
$webIndex = $webIndex.Replace('  // Service worker for web PWA only - skip in Tauri (sw.js not bundled) and Android' + $nl + '  if (''serviceWorker'' in navigator && location.protocol !== ''tauri:'' && typeof window.TaskpadAndroid === ''undefined'')', '  if (''serviceWorker'' in navigator)')
$webIndex = [regex]::Replace($webIndex, '<meta name="theme-color" content="#fdf6ec">\s*<!-- manifest and apple-touch-icon are web/PWA only - not present in tray build -->', '  <meta name="theme-color" content="#fdf6ec">' + $nl + '  <link rel="manifest" href="manifest.json">' + $nl + '  <link rel="apple-touch-icon" href="icon-192.png">', 1)
$webIndex = [regex]::Replace($webIndex, '<!--\s*Fonts: run `node download-fonts\.mjs` once to bundle fonts locally \(offline use\)\.\s*That creates src/fonts/ and src/fonts\.css\. The app detects this automatically\.\s*-->', '  <!-- Fonts: run `node download-fonts.mjs` once to bundle fonts locally for offline PWA use -->', 1)
$webIndex = [regex]::Replace($webIndex, '(?s)/\*[^\n]*Tauri panel overrides[^\n]*\*/\s*html\.tauri-panel \{[^}]*\}\s*html\.tauri-panel \.app \{[^}]*\}\s*html\.tauri-panel \.binding \{[^}]*\}\s*html\.tauri-panel \.binding \* \{[^}]*\}\s*html\.tauri-panel \.header,\s*html\.tauri-panel \.footer,\s*html\.tauri-panel \.section-header,\s*html\.tauri-panel \.add-priority \{[^}]*\}', $nl + (@(
  '    /* Web / PWA */',
  '    @media (max-width: 400px) { :root { --margin-left: 36px; } }',
  '    @media (display-mode: standalone) {',
  '      .app { padding-bottom: env(safe-area-inset-bottom, 0); }',
  '    }'
) -join $nl), 1)
$webIndex = [regex]::Replace($webIndex, '// Service worker for web PWA only - skip in Tauri \(sw\.js not bundled\) and Android\s*if \(''serviceWorker'' in navigator && location\.protocol !== ''tauri:'' && typeof window\.TaskpadAndroid === ''undefined''\)', '  if (''serviceWorker'' in navigator)', 1)
Write-Utf8NoBom $webIndexPath $webIndex

Write-Host 'Patching Android shell...'
$androidIndexPath = Join-Path $androidSrc 'index.html'
$androidIndex = Load-Text $androidIndexPath
$androidIndex = $androidIndex.Replace((@(
  '    /* ── Tauri panel overrides ── */',
  '    html.tauri-panel { border: 1px solid var(--rule-dark); border-radius: 4px; overflow: hidden; }',
  '    html.tauri-panel .app { height: 100vh; max-height: 100vh; overflow: hidden; }',
  '    html.tauri-panel .binding { -webkit-app-region: drag; cursor: grab; }',
  '    html.tauri-panel .binding * { -webkit-app-region: no-drag; }',
  '    html.tauri-panel .header,',
  '    html.tauri-panel .footer,',
  '    html.tauri-panel .section-header,',
  '    html.tauri-panel .add-priority { user-select: none; -webkit-user-select: none; }'
) -join $nl), (@(
  '    /* ── Android layout ── */',
  '    html, body { height: 100%; overflow: hidden; }',
  '    .app { height: 100dvh; max-height: 100dvh; overflow: hidden;',
  '           padding-bottom: env(safe-area-inset-bottom, 0); }'
) -join $nl))
$androidIndex = [regex]::Replace($androidIndex, '<script>\s*// Service worker for web PWA only[\s\S]*?</script>\s*', '')
$androidIndex = [regex]::Replace($androidIndex, '<script>\s*\(\(\) => \{\s*if \(typeof window\.__TAURI__ === ''undefined''\) return;[\s\S]*?</script>\s*', '')
$androidIndex = [regex]::Replace($androidIndex, '(?s)/\*[^\n]*Tauri panel overrides[^\n]*\*/\s*html\.tauri-panel \{[^}]*\}\s*html\.tauri-panel \.app \{[^}]*\}\s*html\.tauri-panel \.binding \{[^}]*\}\s*html\.tauri-panel \.binding \* \{[^}]*\}\s*html\.tauri-panel \.header,\s*html\.tauri-panel \.footer,\s*html\.tauri-panel \.section-header,\s*html\.tauri-panel \.add-priority \{[^}]*\}', $nl + (@(
  '    /* Android layout */',
  '    html, body { height: 100%; overflow: hidden; }',
  '    .app { height: 100dvh; max-height: 100dvh; overflow: hidden;',
  '           padding-bottom: env(safe-area-inset-bottom, 0); }'
) -join $nl), 1)
$androidBridge = (@(
  '<script>',
  '  (() => {',
  '    if (typeof window.TaskpadAndroid === ''undefined'') return;',
  '    window.onTaskpadResume = () => { if (window.__taskpad) window.__taskpad.pull(); };',
  '    document.addEventListener(''keydown'', e => {',
  '      if (e.key === ''Escape'' || e.key === ''Back'') window.TaskpadAndroid.hidePanel();',
  '    });',
  '    if (navigator.clipboard) {',
  '      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);',
  '      navigator.clipboard.writeText = async text => {',
  '        try { window.TaskpadAndroid.copyToClipboard(text); } catch { return orig(text); }',
  '      };',
  '    }',
  '  })();',
  '</script>',
  ''
) -join $nl)
$androidIndex = [regex]::Replace($androidIndex, '<script>\s*\(\(\) => \{\s*if \(typeof window\.TaskpadAndroid === ''undefined''\) return;[\s\S]*?</script>\s*', $androidBridge)
Write-Utf8NoBom $androidIndexPath $androidIndex

Write-Host 'Variant sync complete.'
