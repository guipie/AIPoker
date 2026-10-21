// Tauri v2 外壳：本应用的所有游戏逻辑都在 TypeScript 引擎里（src/engine/），
// Rust 侧只负责①开窗口 ②注册本地持久化插件（SQLite）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::new().build())
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
