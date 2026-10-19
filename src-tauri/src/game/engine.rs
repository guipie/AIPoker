use crate::game::card::{shuffle, Card, Suit};
use crate::game::rules::{can_beat, detect_pattern, CardPattern};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Landlord,
    Farmer,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GamePhase {
    Idle,
    Bidding,
    Playing,
    // 前端类型里是 "gameover"，这里显式指定，避免 snake_case 变成 "game_over" 造成不匹配
    #[serde(rename = "gameover")]
    GameOver,
}

#[derive(Debug, Clone)]
pub struct Player {
    pub id: usize,
    pub name: String,
    pub hand: Vec<Card>,
    pub role: Role,
    pub is_human: bool,
    /// 该玩家上一手打出的牌（仅当前桌面展示用）
    pub last_play_cards: Vec<Card>,
}

#[derive(Debug, Clone)]
pub struct Game {
    pub phase: GamePhase,
    pub players: Vec<Player>,
    pub landlord_cards: Vec<Card>,
    pub current_player: usize,
    pub last_play: Option<CardPattern>,
    pub last_player: Option<usize>,
    pub pass_count: u8,
    pub winner: Option<Role>,
    pub bid_history: Vec<(usize, u8)>,
    pub current_bid: u8,
    pub message: String,
}

/// 返回给前端的公开状态
#[derive(Debug, Serialize)]
pub struct PlayerInfo {
    pub id: usize,
    pub name: String,
    pub role: Role,
    #[serde(rename = "handCount")]
    pub hand_count: usize,
    #[serde(rename = "isHuman")]
    pub is_human: bool,
    #[serde(rename = "isCurrent")]
    pub is_current: bool,
    #[serde(rename = "lastPlay")]
    pub last_play: Vec<Card>,
}

#[derive(Debug, Serialize)]
pub struct FrontendState {
    pub phase: GamePhase,
    pub players: Vec<PlayerInfo>,
    #[serde(rename = "myHand")]
    pub my_hand: Vec<Card>,
    #[serde(rename = "landlordCards")]
    pub landlord_cards: Vec<Card>,
    #[serde(rename = "currentPlayerId")]
    pub current_player_id: Option<usize>,
    #[serde(rename = "lastPlay")]
    pub last_play: Vec<Card>,
    #[serde(rename = "lastPlayerId")]
    pub last_player_id: Option<usize>,
    #[serde(rename = "passCount")]
    pub pass_count: u8,
    pub winner: Option<Role>,
    #[serde(rename = "bidHistory")]
    pub bid_history: Vec<BidRecord>,
    #[serde(rename = "currentBid")]
    pub current_bid: u8,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct BidRecord {
    #[serde(rename = "playerId")]
    pub player_id: usize,
    pub score: u8,
}

impl Game {
    /// 创建一局新游戏：洗牌、发牌、进入叫地主阶段
    pub fn new() -> Self {
        let mut deck = super::card::full_deck();
        shuffle(&mut deck);

        // 3 个玩家各 17 张，剩余 3 张底牌
        let mut hands: [Vec<Card>; 3] = [vec![], vec![], vec![]];
        for i in 0..51 {
            hands[i % 3].push(deck[i]);
        }
        let landlord_cards: Vec<Card> = deck[51..54].to_vec();

        // 手牌排序（方便人看）
        for h in hands.iter_mut() {
            sort_hand(h);
        }

        let players = vec![
            Player {
                id: 0,
                name: "你".to_string(),
                hand: hands[0].clone(),
                role: Role::Unknown,
                is_human: true,
                last_play_cards: vec![],
            },
            Player {
                id: 1,
                name: "机器人甲".to_string(),
                hand: hands[1].clone(),
                role: Role::Unknown,
                is_human: false,
                last_play_cards: vec![],
            },
            Player {
                id: 2,
                name: "机器人乙".to_string(),
                hand: hands[2].clone(),
                role: Role::Unknown,
                is_human: false,
                last_play_cards: vec![],
            },
        ];

        // 随机起始叫地主玩家
        let start = (rand::random::<usize>()) % 3;
        let start_name = players[start].name.clone();

        Game {
            phase: GamePhase::Bidding,
            players,
            landlord_cards,
            current_player: start,
            last_play: None,
            last_player: None,
            pass_count: 0,
            winner: None,
            bid_history: vec![],
            current_bid: 0,
            message: format!("{} 先叫地主", start_name),
        }
    }

    /// 叫地主：score 0=不叫，1/2/3=叫分
    pub fn bid(&mut self, player_id: usize, score: u8) -> Result<(), String> {
        if self.phase != GamePhase::Bidding {
            return Err("不在叫地主阶段".into());
        }
        if self.current_player != player_id {
            return Err("不是你的回合".into());
        }
        if score > 0 && score <= self.current_bid {
            return Err("叫分必须大于当前最高分".into());
        }

        self.bid_history.push((player_id, score));
        if score > self.current_bid {
            self.current_bid = score;
        }

        // 判断叫地主是否结束：所有人都叫过一次
        if self.bid_history.len() == 3 {
            self.finish_bidding();
        } else {
            self.current_player = (self.current_player + 1) % 3;
            self.message = format!(
                "{} 叫地主",
                self.players[self.current_player].name
            );
        }
        Ok(())
    }

    fn finish_bidding(&mut self) {
        // 最高分者当地主
        if self.current_bid == 0 {
            // 都不叫，强制第一个玩家当地主（简化处理）
            let landlord_id = self.bid_history[0].0;
            self.set_landlord(landlord_id);
            self.message = format!("无人叫地主，{} 当地主", self.players[landlord_id].name);
        } else {
            let landlord_id = self
                .bid_history
                .iter()
                .max_by_key(|(_, s)| *s)
                .unwrap()
                .0;
            self.set_landlord(landlord_id);
            self.message = format!("{} 当地主", self.players[landlord_id].name);
        }
    }

    fn set_landlord(&mut self, landlord_id: usize) {
        for p in self.players.iter_mut() {
            if p.id == landlord_id {
                p.role = Role::Landlord;
                // 把底牌加到手牌
                p.hand.extend(self.landlord_cards.clone());
                sort_hand(&mut p.hand);
            } else {
                p.role = Role::Farmer;
            }
        }
        self.phase = GamePhase::Playing;
        self.current_player = landlord_id; // 地主先出
        self.last_play = None;
        self.last_player = None;
        self.pass_count = 0;
    }

    /// 出牌：cards 是要出的牌
    pub fn play(&mut self, player_id: usize, cards: &[Card]) -> Result<(), String> {
        if self.phase != GamePhase::Playing {
            return Err("不在出牌阶段".into());
        }
        if self.current_player != player_id {
            return Err("不是你的回合".into());
        }
        if cards.is_empty() {
            return Err("出牌不能为空".into());
        }

        let player = &self.players[player_id];
        // 检查牌是否都在手里
        for c in cards {
            if !player.hand.contains(c) {
                return Err("手里没有这张牌".into());
            }
        }

        // 识别牌型
        let pattern = detect_pattern(cards).ok_or("牌型不合法")?;

        // 如果桌面上有牌，必须能压过
        if let Some(ref last) = self.last_play {
            if self.last_player != Some(player_id) {
                if !can_beat(&pattern, last) {
                    return Err("压不过上家的牌".into());
                }
            }
        }

        // 执行出牌
        let player = &mut self.players[player_id];
        for c in cards {
            if let Some(pos) = player.hand.iter().position(|x| x == c) {
                player.hand.remove(pos);
            }
        }
        player.last_play_cards = cards.to_vec();

        self.last_play = Some(pattern);
        self.last_player = Some(player_id);
        self.pass_count = 0;

        // 检查胜利
        if player.hand.is_empty() {
            self.phase = GamePhase::GameOver;
            self.winner = Some(player.role);
            self.message = match player.role {
                Role::Landlord => "地主获胜！".into(),
                Role::Farmer => "农民获胜！".into(),
                Role::Unknown => "游戏结束".into(),
            };
            return Ok(());
        }

        self.next_player();
        Ok(())
    }

    /// 不出
    pub fn pass(&mut self, player_id: usize) -> Result<(), String> {
        if self.phase != GamePhase::Playing {
            return Err("不在出牌阶段".into());
        }
        if self.current_player != player_id {
            return Err("不是你的回合".into());
        }
        if self.last_play.is_none() || self.last_player == Some(player_id) {
            return Err("你是首家，不能不出".into());
        }

        let player = &mut self.players[player_id];
        player.last_play_cards = vec![]; // 不出则清空自己的展示
        self.pass_count += 1;

        // 连续两人不出，桌面清空，最后出牌的人获得先手
        if self.pass_count >= 2 {
            self.last_play = None;
            self.pass_count = 0;
            // current_player 已经是下一个，需要回到 last_player
            if let Some(lp) = self.last_player {
                self.current_player = lp;
            }
        } else {
            self.next_player();
        }
        Ok(())
    }

    fn next_player(&mut self) {
        self.current_player = (self.current_player + 1) % 3;
    }

    /// 转换为前端可见状态
    pub fn to_frontend_state(&self) -> FrontendState {
        let players: Vec<PlayerInfo> = self
            .players
            .iter()
            .map(|p| PlayerInfo {
                id: p.id,
                name: p.name.clone(),
                role: p.role,
                hand_count: p.hand.len(),
                is_human: p.is_human,
                is_current: p.id == self.current_player && self.phase != GamePhase::GameOver,
                last_play: p.last_play_cards.clone(),
            })
            .collect();

        let my_hand = self.players[0].hand.clone();

        // 地主底牌：叫地主结束后才公开
        let landlord_cards = if self.phase == GamePhase::Bidding {
            vec![]
        } else {
            self.landlord_cards.clone()
        };

        FrontendState {
            phase: self.phase,
            players,
            my_hand,
            landlord_cards,
            current_player_id: if self.phase == GamePhase::GameOver {
                None
            } else {
                Some(self.current_player)
            },
            last_play: self.last_play.as_ref().map(|p| p.cards.clone()).unwrap_or_default(),
            last_player_id: self.last_player,
            pass_count: self.pass_count,
            winner: self.winner,
            bid_history: self
                .bid_history
                .iter()
                .map(|(pid, s)| BidRecord {
                    player_id: *pid,
                    score: *s,
                })
                .collect(),
            current_bid: self.current_bid,
            message: self.message.clone(),
        }
    }

    /// 根据 id 找牌
    pub fn find_cards(&self, ids: &[String]) -> Vec<Card> {
        let mut result = vec![];
        for id in ids {
            // id 格式 "suit-rank"
            let parts: Vec<&str> = id.splitn(2, '-').collect();
            if parts.len() != 2 {
                continue;
            }
            let suit = match parts[0] {
                "hearts" => Suit::Hearts,
                "diamonds" => Suit::Diamonds,
                "clubs" => Suit::Clubs,
                "spades" => Suit::Spades,
                "joker" => Suit::Joker,
                _ => continue,
            };
            let rank: u8 = parts[1].parse().unwrap_or(0);
            result.push(Card::new(suit, rank));
        }
        result
    }
}

/// 手牌排序：从大到小
pub fn sort_hand(hand: &mut Vec<Card>) {
    hand.sort_by(|a, b| {
        b.rank.cmp(&a.rank).then_with(|| {
            let order = |s: &Suit| match s {
                Suit::Spades => 0,
                Suit::Hearts => 1,
                Suit::Clubs => 2,
                Suit::Diamonds => 3,
                Suit::Joker => 4,
            };
            order(&a.suit).cmp(&order(&b.suit))
        })
    });
}
