use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl,
};
use tauri_plugin_autostart::MacosLauncher;
use std::sync::Mutex;

const PANEL_W:   u32  = 340;
const PANEL_H:   u32  = 560;
const PANEL_GAP: i32  = 8;
const PANEL_LABEL: &str = "panel";

// Persists the panel's last-used screen position so it reopens where the user left it.
// None = use default position (above system tray).
static SAVED_POSITION: Mutex<Option<PhysicalPosition<i32>>> = Mutex::new(None);

fn save_position_to_disk(app: &AppHandle, pos: PhysicalPosition<i32>) {
    if let Ok(dir) = app.path().app_data_dir() {
        let path = dir.join("panel_position.txt");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(path, format!("{},{}", pos.x, pos.y));
    }
}

fn load_position_from_disk(app: &AppHandle) -> Option<PhysicalPosition<i32>> {
    let dir = app.path().app_data_dir().ok()?;
    let content = std::fs::read_to_string(dir.join("panel_position.txt")).ok()?;
    let mut parts = content.trim().splitn(2, ',');
    let x: i32 = parts.next()?.parse().ok()?;
    let y: i32 = parts.next()?.parse().ok()?;
    Some(PhysicalPosition::new(x, y))
}

// ─── JS-callable commands ─────────────────────────────────────────────────────

#[tauri::command]
fn hide_panel(app: AppHandle) {
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        let _ = w.hide();
    }
}

#[tauri::command]
fn update_tray_tooltip(app: AppHandle, tooltip: String) {
    if let Some(tray) = app.tray_by_id("") {
        let _ = tray.set_tooltip(Some(tooltip.as_str()));
    }
}

#[tauri::command]
fn get_autostart_enabled(app: AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let mgr = app.autolaunch();
    if enabled { let _ = mgr.enable(); } else { let _ = mgr.disable(); }
    rebuild_tray_menu(&app, enabled);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            hide_panel,
            get_autostart_enabled,
            set_autostart,
            update_tray_tooltip,
        ])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            toggle_panel(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .setup(|app| {
            // Restore saved panel position from disk if it exists
            if let Some(pos) = load_position_from_disk(app.handle()) {
                if let Ok(mut saved) = SAVED_POSITION.lock() {
                    *saved = Some(pos);
                }
            }
            build_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == PANEL_LABEL {
                match event {
                    tauri::WindowEvent::Focused(false) => {
                        let w = window.clone();
                        std::thread::spawn(move || {
                            std::thread::sleep(std::time::Duration::from_millis(300));
                            if !w.is_focused().unwrap_or(true) {
                                let _ = w.hide();
                            }
                        });
                    }
                    tauri::WindowEvent::Moved(pos) => {
                        // User dragged the panel - save position in memory and to disk
                        if let Ok(mut saved) = SAVED_POSITION.lock() {
                            *saved = Some(*pos);
                        }
                        save_position_to_disk(window.app_handle(), *pos);
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run taskpad");
}

// ─── Tray ─────────────────────────────────────────────────────────────────────

fn autostart_label(enabled: bool) -> &'static str {
    if enabled { "\u{2713} Start on login" } else { "  Start on login" }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let open  = MenuItem::with_id(app, "open",  "Open",                     true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", autostart_label(autostart_on), true, None::<&str>)?;
    let sep   = tauri::menu::PredefinedMenuItem::separator(app)?;
    let quit  = MenuItem::with_id(app, "quit",  "Quit Taskpad",             true, None::<&str>)?;
    let menu  = Menu::with_items(app, &[&open, &start, &sep, &quit])?;

    TrayIconBuilder::new()
        .icon(load_tray_icon())
        .tooltip("Taskpad")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button:       MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event {
                toggle_panel(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open"  => toggle_panel(app),
            "quit"  => app.exit(0),
            "start" => {
                use tauri_plugin_autostart::ManagerExt;
                let mgr = app.autolaunch();
                let currently = mgr.is_enabled().unwrap_or(false);
                if currently { let _ = mgr.disable(); } else { let _ = mgr.enable(); }
                rebuild_tray_menu(app, !currently);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}

fn rebuild_tray_menu<R: Runtime>(app: &AppHandle<R>, autostart_on: bool) {
    if let Some(tray) = app.tray_by_id("") {
        if let Ok(open)  = MenuItem::with_id(app, "open",  "Open",                        true, None::<&str>) {
        if let Ok(start) = MenuItem::with_id(app, "start", autostart_label(autostart_on), true, None::<&str>) {
        if let Ok(sep)   = tauri::menu::PredefinedMenuItem::separator(app) {
        if let Ok(quit)  = MenuItem::with_id(app, "quit",  "Quit Taskpad",                true, None::<&str>) {
        if let Ok(menu)  = Menu::with_items(app, &[&open, &start, &sep, &quit]) {
            let _ = tray.set_menu(Some(menu));
        }}}}}
    }
}

// ─── Panel toggle ─────────────────────────────────────────────────────────────

fn toggle_panel<R: Runtime>(app: &AppHandle<R>) {
    match app.get_webview_window(PANEL_LABEL) {
        Some(panel) => {
            if panel.is_visible().unwrap_or(false) {
                let _ = panel.hide();
            } else {
                position_and_show(&panel);
            }
        }
        None => {
            if let Ok(panel) = create_panel(app) {
                position_and_show(&panel);
            }
        }
    }
}

fn create_panel<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    WebviewWindowBuilder::new(app, PANEL_LABEL, WebviewUrl::App("index.html".into()))
        .title("")
        .inner_size(PANEL_W as f64, PANEL_H as f64)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(true)
        .visible(false)
        // Intercept scroll before WebView2 DirectManipulation claims it.
        // This script runs before the page and captures wheel events globally.
        .initialization_script(r#"
            (function() {
                // WebView2 on Windows uses DirectManipulation which can intercept
                // trackpad scroll before the DOM sees it. We capture wheel events
                // at the top level and manually scroll the correct container.
                window.addEventListener('wheel', function(e) {
                    // Don't intercept scroll inside text inputs
                    var t = e.target;
                    while (t && t !== document.documentElement) {
                        if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return;
                        t = t.parentElement;
                    }

                    // deltaMode: 0=pixels (trackpad), 1=lines (mouse wheel), 2=pages
                    var lineH  = 28;
                    var delta;
                    if      (e.deltaMode === 0) delta = e.deltaY * 2.5;
                    else if (e.deltaMode === 1) delta = e.deltaY * lineH;
                    else                        delta = e.deltaY * window.innerHeight * 0.9;

                    // Walk up from target to find the scrollable container
                    var el = e.target;
                    while (el && el !== document.documentElement) {
                        var style = window.getComputedStyle(el);
                        var oy = style.overflowY;
                        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
                            // Only prevent default if we can actually scroll in the requested direction
                            var canScroll = (delta > 0 && el.scrollTop < el.scrollHeight - el.clientHeight)
                                         || (delta < 0 && el.scrollTop > 0);
                            if (canScroll) {
                                e.preventDefault();
                                el.scrollTop += delta;
                            }
                            return;
                        }
                        el = el.parentElement;
                    }
                }, { passive: false, capture: true });
            })();
        "#)
        .build()
}

// ─── Positioning ──────────────────────────────────────────────────────────────

fn position_and_show<R: Runtime>(panel: &tauri::WebviewWindow<R>) {
    // Find the monitor containing the cursor (i.e. where the tray icon is)
    // by checking which monitor's bounds contain the current cursor position.
    let cursor_pos = panel.cursor_position().ok();

    let monitor = cursor_pos
        .as_ref()
        .and_then(|pos| {
            panel.available_monitors().ok()?.into_iter().find(|m| {
                let mp = m.position();
                let ms = m.size();
                // cursor_position() returns PhysicalPosition<f64> - already physical pixels
                // Monitor position/size are also physical pixels
                let left   = mp.x as f64;
                let top    = mp.y as f64;
                let right  = mp.x as f64 + ms.width  as f64;
                let bottom = mp.y as f64 + ms.height as f64;
                pos.x >= left && pos.x < right && pos.y >= top && pos.y < bottom
            })
        })
        .or_else(|| panel.primary_monitor().ok().flatten())
        .or_else(|| panel.current_monitor().ok().flatten());

    let Some(monitor) = monitor else {
        let _ = panel.show();
        let _ = panel.set_focus();
        return;
    };

    let scale = monitor.scale_factor();
    let size  = monitor.size();
    let pos   = monitor.position();

    let ph  = (PANEL_H as f64 * scale) as i32;
    let pw  = (PANEL_W as f64 * scale) as i32;
    let gap = (PANEL_GAP as f64 * scale) as i32;
    let sw  = size.width  as i32;
    let sx  = pos.x;
    let sy  = pos.y;

    // Get the actual work area (screen minus taskbar) using Win32 on Windows.
    // On other platforms fall back to an estimated taskbar height.
    #[cfg(target_os = "windows")]
    let work_bottom = get_work_area_bottom(pos.x, pos.y, size.width, size.height);
    #[cfg(not(target_os = "windows"))]
    let work_bottom = pos.y + size.height as i32 - (40.0 * scale) as i32;

    let x = sx + sw - pw - gap;
    let y = (work_bottom - ph - gap).max(sy + gap);

    let _ = panel.set_size(PhysicalSize::new(pw as u32, ph as u32));

    // Use saved position if user previously dragged the panel, but only if it's
    // still within the usable work area (guard against monitor layout changes)
    let saved = SAVED_POSITION.lock().ok().and_then(|s| *s);
    let position = if let Some(saved_pos) = saved {
        let on_screen = saved_pos.x >= sx
            && saved_pos.y >= sy
            && saved_pos.x + pw <= sx + sw
            && saved_pos.y + ph <= work_bottom;  // use work_bottom not raw height
        if on_screen { saved_pos } else { PhysicalPosition::new(x, y) }
    } else {
        PhysicalPosition::new(x, y)
    };

    let _ = panel.set_position(position);
    let _ = panel.show();
    let _ = panel.set_focus();

    // Remove from taskbar and Alt+Tab on Windows
    #[cfg(target_os = "windows")]
    set_tool_window(panel);
}

// ─── Windows: force panel out of taskbar / Alt+Tab ────────────────────────────
//
// Tauri's skip_taskbar() is not always respected on Windows - particularly
// when always_on_top is also set. We enforce it directly via Win32 by setting
// WS_EX_TOOLWINDOW and clearing WS_EX_APPWINDOW on the underlying HWND.

#[cfg(target_os = "windows")]
fn set_tool_window<R: Runtime>(panel: &tauri::WebviewWindow<R>) {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW,
        GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };

    if let Ok(handle) = panel.window_handle() {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let hwnd = HWND(win32.hwnd.get() as _);
            unsafe {
                let ex      = GetWindowLongW(hwnd, GWL_EXSTYLE);
                let new_ex  = (ex & !(WS_EX_APPWINDOW.0 as i32))
                            | WS_EX_TOOLWINDOW.0 as i32;
                SetWindowLongW(hwnd, GWL_EXSTYLE, new_ex);
            }
        }
    }
}

// ─── Windows: get actual work area bottom per-monitor (excludes taskbar at any position/size) ───
//
// SPI_GETWORKAREA only returns the PRIMARY monitor's work area.
// GetMonitorInfo with the HMONITOR containing the cursor gives the correct
// work area for whichever monitor the panel will appear on.

#[cfg(target_os = "windows")]
fn get_work_area_bottom(mon_x: i32, mon_y: i32, mon_w: u32, mon_h: u32) -> i32 {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    // Use the centre of the monitor to find its HMONITOR handle
    let centre = POINT {
        x: mon_x + (mon_w / 2) as i32,
        y: mon_y + (mon_h / 2) as i32,
    };

    let hmon = unsafe { MonitorFromPoint(centre, MONITOR_DEFAULTTONEAREST) };

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };

    let ok = unsafe { GetMonitorInfoW(hmon, &mut info) };

    if ok.as_bool() && info.rcWork.bottom > info.rcWork.top {
        info.rcWork.bottom
    } else {
        // API failed - fall back to full height minus standard 40px taskbar
        mon_y + mon_h as i32 - 40
    }
}

// ─── Icon ─────────────────────────────────────────────────────────────────────

fn load_tray_icon() -> Image<'static> {
    let bytes = include_bytes!("../icons/tray.png");
    Image::from_bytes(bytes).expect("tray.png is not a valid PNG")
}

