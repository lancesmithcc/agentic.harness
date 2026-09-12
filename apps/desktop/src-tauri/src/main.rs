// agentic.harness — a native macOS window around the agentic.harness web UI.
//
// On launch it shows a bundled splash, then either reuses a harness already
// answering on 127.0.0.1:8790 or starts the bundled `harness-server` binary
// (bound to 127.0.0.1, with the login shell's PATH and keys so claude/codex
// are found). The server this app started is stopped when the app quits.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{
    AppHandle, Manager, RunEvent, TitleBarStyle, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const PORT: u16 = 8790;
/// Safari's WebKit UA plus a tag the page uses to switch on native title-bar spacing.
const USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) AgenticHarness/0.1";
const LOG_HINT: &str = "See ~/.deepharness/logs/desktop-server.log";

/// The harness server this app started (None when an existing one was reused).
struct Sidecar(Mutex<Option<Child>>);

fn harness_url() -> Url {
    Url::parse(&format!("http://127.0.0.1:{PORT}/")).expect("static harness url")
}

/// Something on the port answers like a agentic.harness server.
fn harness_running() -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let request = b"GET /api/settings HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n";
    if stream.write_all(request).is_err() {
        return false;
    }
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw);
    text.starts_with("HTTP/1.1 200") && text.contains("\"theme\"")
}

/// Apps opened from Finder get launchd's bare environment. Borrow the login
/// shell's (PATH, API keys) so the harness can find claude, codex and bun.
fn login_shell_env() -> HashMap<String, String> {
    const MARKER: &str = "__AGENTIC_ENV_START__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let Ok(mut child) = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARKER}'; /usr/bin/env -0")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return HashMap::new();
    };

    // Read on a thread: a chatty profile could fill the pipe, and background
    // jobs started by the profile may hold it open after the shell exits.
    let (tx, rx) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        thread::spawn(move || {
            let mut out = Vec::new();
            let _ = stdout.read_to_end(&mut out);
            let _ = tx.send(out);
        });
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return HashMap::new();
            }
        }
    }
    let Ok(out) = rx.recv_timeout(Duration::from_secs(2)) else {
        return HashMap::new();
    };
    let text = String::from_utf8_lossy(&out);
    let Some(start) = text.find(MARKER) else {
        return HashMap::new();
    };
    text[start + MARKER.len()..]
        .split('\0')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(key, _)| !key.is_empty() && !matches!(*key, "PWD" | "OLDPWD" | "SHLVL" | "_"))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

fn spawn_sidecar(app: &AppHandle) -> Result<Child, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = exe
        .parent()
        .map(|dir| dir.join("harness-server"))
        .ok_or("the app has no executable folder")?;
    if !bin.exists() {
        return Err(format!("harness-server is missing from the app ({})", bin.display()));
    }
    let web_root = app.path().resource_dir().map_err(|e| e.to_string())?.join("web");
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let dsh_root = resource_dir.join("dsh-runtime");
    let dsh_node = dsh_root.join("node").join("bin").join("node");
    if !dsh_node.is_file() {
        return Err(format!("bundled DeepSeek Node runtime is missing ({})", dsh_node.display()));
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;

    let log_path = home.join(".deepharness").join("logs").join("desktop-server.log");
    if let Some(dir) = log_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("cannot open {}: {e}", log_path.display()))?;
    let err_log = log.try_clone().map_err(|e| e.to_string())?;

    let mut env = login_shell_env();
    if env.is_empty() {
        env = std::env::vars().collect();
    }
    // Make sure the usual CLI install locations are reachable even if the
    // shell environment could not be read.
    let mut path: Vec<String> = env
        .get("PATH")
        .map(|p| p.split(':').filter(|s| !s.is_empty()).map(String::from).collect())
        .unwrap_or_default();
    for dir in [
        home.join(".local/bin"),
        home.join(".bun/bin"),
        home.join(".cargo/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ] {
        let dir = dir.to_string_lossy().to_string();
        if !path.contains(&dir) {
            path.push(dir);
        }
    }
    env.insert("PATH".into(), path.join(":"));
    env.insert("HOME".into(), home.to_string_lossy().to_string());

    Command::new(&bin)
        .env_clear()
        .envs(&env)
        .env("HARNESS_WEB_ROOT", &web_root)
        .env("HARNESS_DSH_BRIDGE", dsh_root.join("deepseek-bridge.mjs"))
        .env("HARNESS_NODE_PATH", dsh_node)
        .env("HARNESS_WEB_HOST", "127.0.0.1")
        .env("HARNESS_WEB_PORT", PORT.to_string())
        .env("HARNESS_CLIENT", "desktop")
        .current_dir(&home)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err_log)
        .spawn()
        .map_err(|e| format!("could not start harness-server: {e}"))
}

fn ensure_harness(app: &AppHandle) -> Result<(), String> {
    if harness_running() {
        return Ok(());
    }
    let child = spawn_sidecar(app)?;
    app.state::<Sidecar>().0.lock().unwrap().replace(child);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(45) {
        if harness_running() {
            return Ok(());
        }
        if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().as_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("The harness server stopped while starting ({status}).\n{LOG_HINT}"));
            }
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!("The harness server did not answer within 45 seconds.\n{LOG_HINT}"))
}

fn boot(app: AppHandle, window: WebviewWindow) {
    match ensure_harness(&app) {
        Ok(()) => {
            let _ = window.navigate(harness_url());
        }
        Err(message) => {
            thread::sleep(Duration::from_millis(400)); // let the splash define showError
            let arg = serde_json::to_string(&message).unwrap_or_else(|_| "\"The harness failed to start.\"".into());
            let _ = window.eval(&format!("window.showError && window.showError({arg})"));
        }
    }
}

/// Pages that stay inside the app window: the splash and the harness itself.
fn is_app_url(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" => matches!(url.host_str(), Some("127.0.0.1") | Some("localhost")) && url.port() == Some(PORT),
        _ => false,
    }
}

fn open_in_browser(url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

fn unique_download_path(dir: &Path, suggested: &Path) -> PathBuf {
    let name = suggested
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "download".into());
    let first = dir.join(&name);
    if !first.exists() {
        return first;
    }
    let as_path = Path::new(&name);
    let stem = as_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| name.clone());
    let ext = as_path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..10_000)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap_or(first)
}

fn toast_js(message: &str) -> String {
    let msg = serde_json::to_string(message).unwrap_or_else(|_| "\"Saved\"".into());
    format!(
        r#"(function(){{var t=document.createElement("div");t.textContent={msg};t.setAttribute("style","position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;padding:9px 18px;border-radius:9999px;background:#FB923C;color:#0A0908;font:500 13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)");document.body.appendChild(t);setTimeout(function(){{t.remove()}},2800);}})()"#
    )
}

fn main() {
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let downloads = app.path().download_dir().unwrap_or_else(|_| std::env::temp_dir());
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("agentic.harness")
                .inner_size(1320.0, 860.0)
                .min_inner_size(960.0, 640.0)
                .title_bar_style(TitleBarStyle::Overlay)
                .hidden_title(true)
                .user_agent(USER_AGENT)
                // let the chat's own drop zone receive dragged files
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    if is_app_url(url) {
                        return true;
                    }
                    open_in_browser(url);
                    false
                })
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .on_download(move |webview, event| {
                    match event {
                        DownloadEvent::Requested { destination, .. } => {
                            let target = unique_download_path(&downloads, destination);
                            *destination = target;
                        }
                        DownloadEvent::Finished { path: Some(path), success: true, .. } => {
                            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                            let _ = webview.eval(&toast_js(&format!("Saved to Downloads — {name}")));
                        }
                        _ => {}
                    }
                    true
                })
                .build()?;
            let handle = app.handle().clone();
            thread::spawn(move || boot(handle, window));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the agentic.harness app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        });
}
