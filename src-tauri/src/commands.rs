use crate::game::card::Card;
use crate::game::engine::{FrontendState, Game, GamePhase, Role};
use crate::game::llm::{self, LlmConfig};
use crate::game::rules::{can_beat, detect_pattern, CardPattern};
use serde::Deserialize;
use tauri::State;
use std::sync::Mutex;

/// 全局游戏状态
pub struct GameState(pub Mutex<Game>);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PlayAction {
    Play { cards: Vec<String> },
    Pass,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BidAction {
    Bid { score: u8 },
    Pass,
}

#[tauri::command]
pub fn new_game(state: State<GameState>) -> FrontendState {
    let game = Game::new();
    *state.0.lock().unwrap() = game.clone();
    game.to_frontend_state()
}

#[tauri::command]
pub fn human_bid(state: State<GameState>, action: BidAction) -> Result<FrontendState, String> {
    let mut game = state.0.lock().unwrap();
    let score = match action {
        BidAction::Bid { score } => score,
        BidAction::Pass => 0,
    };
    game.bid(0, score)?;
    Ok(game.to_frontend_state())
}

#[tauri::command]
pub fn bot_bid(state: State<GameState>) -> Result<FrontendState, String> {
    let mut game = state.0.lock().unwrap();
    crate::game::bot::bot_bid_step(&mut game)?;
    Ok(game.to_frontend_state())
}

#[tauri::command]
pub fn human_play(state: State<GameState>, action: PlayAction) -> Result<FrontendState, String> {
    let mut game = state.0.lock().unwrap();
    match action {
        PlayAction::Play { cards } => {
            let cards: Vec<Card> = game.find_cards(&cards);
            game.play(0, &cards)?;
        }
        PlayAction::Pass => {
            game.pass(0)?;
        }
    }
    Ok(game.to_frontend_state())
}

#[tauri::command]
pub fn bot_play(state: State<GameState>) -> Result<FrontendState, String> {
    let mut game = state.0.lock().unwrap();
    crate::game::bot::bot_play_step(&mut game)?;
    Ok(game.to_frontend_state())
}

#[tauri::command]
pub fn detect_pattern_cmd(state: State<GameState>, card_ids: Vec<String>) -> Option<CardPattern> {
    let game = state.0.lock().unwrap();
    let cards = game.find_cards(&card_ids);
    detect_pattern(&cards)
}

#[tauri::command]
pub fn can_beat_cmd(
    state: State<GameState>,
    selected: Vec<String>,
    last_play: Option<Vec<String>>,
) -> bool {
    let game = state.0.lock().unwrap();
    let sel_cards = game.find_cards(&selected);
    let Some(sel_pat) = detect_pattern(&sel_cards) else {
        return false;
    };
    match last_play {
        Some(ids) if !ids.is_empty() => {
            let last_cards = game.find_cards(&ids);
            let Some(last_pat) = detect_pattern(&last_cards) else {
                return false;
            };
            can_beat(&sel_pat, &last_pat)
        }
        _ => true, // 首家任意合法牌型都可以
    }
}

#[tauri::command]
pub fn debug_get_all_hands(state: State<GameState>) -> std::collections::HashMap<String, Vec<Card>> {
    let game = state.0.lock().unwrap();
    let mut m = std::collections::HashMap::new();
    for p in &game.players {
        m.insert(p.name.clone(), p.hand.clone());
    }
    m
}

/// LLM 决策管道：LLM 提建议 → 规则引擎校验 → 执行（失败自动回退本地机器人）。
/// 该 command 为 async：调用 LLM 期间不持有游戏锁，避免阻塞。
#[tauri::command]
pub async fn llm_bot_step(
    state: State<'_, GameState>,
    config: LlmConfig,
) -> Result<FrontendState, String> {
    // 1. 持锁读取状态并构造 prompt（锁在进入 await 前释放）
    let (system, user) = {
        let game = state.0.lock().unwrap();
        match game.phase {
            GamePhase::Bidding | GamePhase::Playing => llm::build_prompt(&game, &config),
            _ => return Ok(game.to_frontend_state()),
        }
    };

    // 2. 调用 LLM（不持锁）。失败也不报错，交给下一步兜底
    let reply = llm::chat(&config, &system, &user).await.ok();

    // 3. 解析意图 → 规则校验 → 执行，非法则回退到规则引擎
    let mut game = state.0.lock().unwrap();
    llm::apply_from_reply(&mut game, reply.as_deref())?;
    Ok(game.to_frontend_state())
}

/// 给人类玩家的出牌提示：复用机器人逻辑，返回一组可出的牌的 id。
/// 返回 null 表示没有建议（应该不出）。
#[tauri::command]
pub fn hint_play(state: State<GameState>) -> Option<Vec<String>> {
    let game = state.0.lock().unwrap();
    if game.phase != GamePhase::Playing || game.current_player != 0 {
        return None;
    }
    let pid = 0usize;
    let hand = game.players[pid].hand.clone();
    let my_role = game.players[pid].role;
    let last_player_role = game
        .last_player
        .map(|lp| game.players[lp].role)
        .unwrap_or(Role::Unknown);
    let teammate_hand_count = if my_role == Role::Farmer {
        game.players
            .iter()
            .find(|p| p.id != pid && p.role == Role::Farmer)
            .map(|p| p.hand.len())
            .unwrap_or(0)
    } else {
        0
    };

    crate::game::bot::decide_play(
        &hand,
        game.last_play.as_ref(),
        last_player_role,
        my_role,
        teammate_hand_count,
    )
    .map(|cards| cards.iter().map(|c| c.id()).collect())
}
