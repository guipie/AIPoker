//! LLM 决策模块
//!
//! 管道：构造 prompt → 调用 OpenAI 兼容接口 → 解析严格 JSON 意图 →
//! 用规则引擎校验 → 执行。任何一步失败都会回退到本地启发式机器人（bot.rs），
//! 保证牌局永远不会因为模型抽风而卡死。

use crate::game::bot;
use crate::game::card::Card;
use crate::game::engine::{Game, GamePhase, Role};
use crate::game::rules::{can_beat, detect_pattern, PatternType};
use serde::{Deserialize, Serialize};

const DEFAULT_TEMPERATURE: f32 = 0.6;
const REQUEST_TIMEOUT_SECS: u64 = 20;

/// 前端传入的 LLM 配置（字段名与 TS 端 camelCase 对齐）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default = "default_temperature")]
    pub temperature: f32,
}

fn default_temperature() -> f32 {
    DEFAULT_TEMPERATURE
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage>,
    temperature: f32,
    stream: bool,
}

#[derive(Serialize, Deserialize)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatMessage,
}

/// 调用 OpenAI 兼容的 /chat/completions 接口，返回模型文本
pub async fn chat(config: &LlmConfig, system: &str, user: &str) -> Result<String, String> {
    if config.api_key.trim().is_empty() {
        return Err("未配置 API Key".into());
    }
    if config.model.trim().is_empty() {
        return Err("未配置模型名称".into());
    }

    let url = format!(
        "{}/chat/completions",
        config.base_url.trim_end_matches('/')
    );
    let body = ChatRequest {
        model: config.model.trim(),
        messages: vec![
            ChatMessage {
                role: "system".into(),
                content: system.into(),
            },
            ChatMessage {
                role: "user".into(),
                content: user.into(),
            },
        ],
        temperature: config.temperature,
        stream: false,
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", config.api_key.trim()))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 LLM 失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("LLM 返回错误 {status}: {}", truncate(&text, 300)));
    }

    let parsed: ChatResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 LLM 响应失败: {e}"))?;

    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| c.message.content)
        .ok_or_else(|| "LLM 未返回任何内容".to_string())
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let t: String = s.chars().take(max).collect();
        format!("{t}…")
    }
}

// ---------------- Prompt 构造 ----------------

/// 根据当前阶段构造 (system, user) prompt
pub fn build_prompt(game: &Game, config: &LlmConfig) -> (String, String) {
    match game.phase {
        GamePhase::Bidding => build_bid_prompt(game, config),
        _ => build_play_prompt(game, config),
    }
}

fn system_prompt(config: &LlmConfig, name: &str) -> String {
    let persona = if config.persona.trim().is_empty() {
        String::new()
    } else {
        format!("你的人设：{}。\n", config.persona.trim())
    };
    format!(
        "你是一名斗地主高手，正在扮演玩家「{name}」。\n\
         {persona}\
         牌面编码：3~10 用数字表示，J=11，Q=12，K=13，A=14，2=15，小王=16，大王=17。\n\
         每张牌的 id 形如「花色-点数」，花色取值 hearts/diamonds/clubs/spades/joker，\
         例如 spades-14 表示黑桃A，joker-17 表示大王。\n\
         你只能输出严格的 JSON，禁止输出任何解释、markdown、代码块或多余文字。"
    )
}

fn hand_ids(hand: &[Card]) -> String {
    hand.iter()
        .map(|c| c.id())
        .collect::<Vec<_>>()
        .join(", ")
}

fn rank_text(r: u8) -> String {
    match r {
        11 => "J".into(),
        12 => "Q".into(),
        13 => "K".into(),
        14 => "A".into(),
        15 => "2".into(),
        16 => "小王".into(),
        17 => "大王".into(),
        n => n.to_string(),
    }
}

fn role_text(r: Role) -> &'static str {
    match r {
        Role::Landlord => "地主",
        Role::Farmer => "农民",
        Role::Unknown => "未知",
    }
}

fn pattern_text(p: PatternType) -> &'static str {
    use PatternType::*;
    match p {
        Single => "单张",
        Pair => "对子",
        Triple => "三张",
        TripleSingle => "三带一",
        TriplePair => "三带二",
        Straight => "顺子",
        PairStraight => "连对",
        Airplane => "飞机",
        AirplaneSingle => "飞机带单",
        AirplanePair => "飞机带对",
        FourTwoSingle => "四带二(单)",
        FourTwoPair => "四带二(对)",
        Bomb => "炸弹",
        Rocket => "王炸",
    }
}

fn others_summary(game: &Game, pid: usize) -> String {
    game.players
        .iter()
        .filter(|p| p.id != pid)
        .map(|p| format!("{}（{}，剩 {} 张）", p.name, role_text(p.role), p.hand.len()))
        .collect::<Vec<_>>()
        .join("；")
}

fn build_bid_prompt(game: &Game, config: &LlmConfig) -> (String, String) {
    let pid = game.current_player;
    let p = &game.players[pid];
    let system = system_prompt(config, &p.name);
    let user = format!(
        "当前是【叫地主】阶段。\n\
         你的手牌（{} 张）：{}\n\
         当前最高叫分：{} 分。\n\
         请决定叫分：分数为 1/2/3，且必须大于当前最高叫分；若不叫则返回 pass。\n\
         只输出 JSON，例如 {{\"action\":\"bid\",\"score\":2}} 或 {{\"action\":\"pass\"}}。",
        p.hand.len(),
        hand_ids(&p.hand),
        game.current_bid,
    );
    (system, user)
}

fn build_play_prompt(game: &Game, config: &LlmConfig) -> (String, String) {
    let pid = game.current_player;
    let p = &game.players[pid];
    let system = system_prompt(config, &p.name);

    let leading = game.last_play.is_none() || game.last_player == Some(pid);

    let mut lines = vec![
        "当前是【出牌】阶段。".to_string(),
        format!(
            "你的身份：{}。",
            if p.role == Role::Landlord {
                "地主（对手是两个农民）"
            } else {
                "农民（队友是另一个农民，对手是地主）"
            }
        ),
        format!("你的手牌（{} 张）：{}", p.hand.len(), hand_ids(&p.hand)),
        format!("场上其余玩家：{}", others_summary(game, pid)),
    ];

    if leading {
        lines.push("你是本轮首家（桌面已无人压牌），必须出牌，不能 pass。".into());
        lines.push("请出任意合法牌型，优先出最小、最不划算的牌。".into());
    } else {
        let last = game.last_play.as_ref().expect("非首家时必有 last_play");
        let last_name = game
            .last_player
            .map(|lp| game.players[lp].name.clone())
            .unwrap_or_default();
        lines.push(format!(
            "上家「{}」出了 {}（主点数 {}），牌为：{}。",
            last_name,
            pattern_text(last.type_),
            rank_text(last.main_rank),
            hand_ids(&last.cards)
        ));
        lines.push(
            "你只有两种选择：出一手能压过它的牌（同牌型且主点数更大，或炸弹/王炸），或者返回 pass。"
                .into(),
        );
        lines.push("如果压牌的代价太大（需要拆炸弹或打出很大的牌），也可以选择 pass。".into());
    }

    lines.push(
        "只输出 JSON，例如 {\"action\":\"play\",\"cards\":[\"spades-14\",\"hearts-3\"]} 或 {\"action\":\"pass\"}。"
            .into(),
    );

    (system, lines.join("\n"))
}

// ---------------- 意图解析与校验执行 ----------------

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum BidIntent {
    Bid { score: u8 },
    Pass,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
enum PlayIntent {
    Play { cards: Vec<String> },
    Pass,
}

/// 从模型回复里提取第一个 JSON 对象并反序列化
fn parse_json<T: for<'de> Deserialize<'de>>(text: &str) -> Option<T> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&text[start..=end]).ok()
}

/// 执行一次 LLM 决策：解析 → 校验 → 执行；失败则回退到规则机器人
pub fn apply_from_reply(game: &mut Game, reply: Option<&str>) -> Result<(), String> {
    match game.phase {
        GamePhase::Bidding => apply_bid(game, reply),
        GamePhase::Playing => apply_play(game, reply),
        _ => Ok(()),
    }
}

fn apply_bid(game: &mut Game, reply: Option<&str>) -> Result<(), String> {
    let pid = game.current_player;
    if let Some(text) = reply {
        if let Some(intent) = parse_json::<BidIntent>(text) {
            let score = match intent {
                BidIntent::Bid { score } => score,
                BidIntent::Pass => 0,
            };
            // 校验：分数必须在 0..=3，且叫分必须高于当前最高叫分
            let valid = score <= 3 && (score == 0 || score > game.current_bid);
            if valid {
                return game.bid(pid, score);
            }
        }
    }
    bot::bot_bid_step(game)
}

fn apply_play(game: &mut Game, reply: Option<&str>) -> Result<(), String> {
    let pid = game.current_player;
    let leading = game.last_play.is_none() || game.last_player == Some(pid);

    if let Some(text) = reply {
        if let Some(intent) = parse_json::<PlayIntent>(text) {
            match intent {
                PlayIntent::Pass => {
                    if !leading {
                        // 不是首家才允许不出
                        return game.pass(pid);
                    }
                }
                PlayIntent::Play { cards: ids } => {
                    if let Some(cards) = validate_play(game, pid, &ids, leading) {
                        return game.play(pid, &cards);
                    }
                }
            }
        }
    }
    // 模型没给回复 / JSON 不合法 / 出的牌不合规 → 回退规则引擎
    bot::bot_play_step(game)
}

/// 校验 LLM 给出的出牌：牌必须都在手里（且不重复）、牌型合法、能压过桌面
fn validate_play(game: &Game, pid: usize, ids: &[String], leading: bool) -> Option<Vec<Card>> {
    if ids.is_empty() {
        return None;
    }
    let hand = &game.players[pid].hand;
    let cards = game.find_cards(ids);
    // find_cards 会静默跳过非法 id，长度不一致说明出现了非法 id
    if cards.len() != ids.len() {
        return None;
    }

    // 逐张从手牌副本里扣除，可同时拦截「同一张牌重复出现」的情况
    let mut rest = hand.clone();
    for c in &cards {
        let pos = rest.iter().position(|x| x == c)?;
        rest.remove(pos);
    }

    let pattern = detect_pattern(&cards)?;

    if leading {
        return Some(cards);
    }
    let last = game.last_play.as_ref()?;
    if can_beat(&pattern, last) {
        Some(cards)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::bot;

    #[test]
    fn test_parse_bid_intent() {
        let i: BidIntent = parse_json("好的，{\"action\":\"bid\",\"score\":2}").unwrap();
        match i {
            BidIntent::Bid { score } => assert_eq!(score, 2),
            _ => panic!("应为 bid"),
        }
        let i: BidIntent = parse_json("{\"action\":\"pass\"}").unwrap();
        assert!(matches!(i, BidIntent::Pass));
    }

    #[test]
    fn test_parse_play_intent() {
        let i: PlayIntent =
            parse_json("```json\n{\"action\":\"play\",\"cards\":[\"spades-14\"]}\n```").unwrap();
        match i {
            PlayIntent::Play { cards } => assert_eq!(cards, vec!["spades-14".to_string()]),
            _ => panic!("应为 play"),
        }
    }

    #[test]
    fn test_parse_invalid_json() {
        assert!(parse_json::<BidIntent>("没有任何 json").is_none());
        assert!(parse_json::<BidIntent>("{不是合法 json}").is_none());
    }

    /// 把游戏推进到出牌阶段
    fn game_in_playing() -> Game {
        let mut game = Game::new();
        let mut guard = 0;
        while game.phase == GamePhase::Bidding && guard < 10 {
            bot::bot_bid_step(&mut game).unwrap();
            guard += 1;
        }
        assert_eq!(game.phase, GamePhase::Playing);
        game
    }

    /// 模型返回垃圾内容时应回退到规则机器人并正常推进，而不是报错卡死
    #[test]
    fn test_apply_bid_fallback_on_garbage() {
        let mut game = Game::new();
        apply_from_reply(&mut game, Some("完全不是 JSON")).expect("应回退且不报错");
        assert_eq!(game.bid_history.len(), 1, "应完成一次叫分");
    }

    /// 模型给出了合法的牌 → 应当被采纳执行
    #[test]
    fn test_apply_play_accepts_valid_llm_card() {
        let mut game = game_in_playing();
        let pid = game.current_player;
        // 手牌已从大到小排序，取最后一张（最小的一张）作为首家的合法单牌
        let card = *game.players[pid].hand.last().unwrap();
        let reply = format!("{{\"action\":\"play\",\"cards\":[\"{}\"]}}", card.id());
        apply_from_reply(&mut game, Some(&reply)).unwrap();
        assert!(
            !game.players[pid].hand.contains(&card),
            "给出的牌应被真正打出"
        );
    }

    /// 模型给出了不合法的牌（不在手里）→ 应被规则校验拦截并回退
    #[test]
    fn test_apply_play_fallback_on_illegal_cards() {
        let mut game = game_in_playing();
        let pid = game.current_player;
        let before = game.players[pid].hand.len();
        // hearts-99 不是合法牌 id
        let reply = "{\"action\":\"play\",\"cards\":[\"hearts-99\"]}";
        apply_from_reply(&mut game, Some(reply)).unwrap();
        assert!(
            game.players[pid].hand.len() < before,
            "非法出牌被拦截后应回退到规则机器人并成功出牌"
        );
    }
}
