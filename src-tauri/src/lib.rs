pub mod game;
mod commands;

use commands::GameState;
use game::engine::Game;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(GameState(std::sync::Mutex::new(Game::new())))
        .invoke_handler(tauri::generate_handler![
            commands::new_game,
            commands::human_bid,
            commands::bot_bid,
            commands::human_play,
            commands::bot_play,
            commands::detect_pattern_cmd,
            commands::can_beat_cmd,
            commands::debug_get_all_hands,
            commands::llm_bot_step,
            commands::hint_play,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
