use serde::{Deserialize, Serialize};
use std::fmt;

/// 花色
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Suit {
    Hearts,
    Diamonds,
    Clubs,
    Spades,
    Joker,
}
impl fmt::Display for Suit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Suit::Hearts => "hearts",
            Suit::Diamonds => "diamonds",
            Suit::Clubs => "clubs",
            Suit::Spades => "spades",
            Suit::Joker => "joker",
        };
        write!(f, "{}", s)
    }
}

/// 一张扑克牌
/// rank: 3..=14 对应 3..A, 15 = 2, 16 = 小王, 17 = 大王
/// 数值越大牌越大
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub struct Card {
    pub suit: Suit,
    pub rank: u8,
}

// 手工实现序列化：在序列化结果里附带一个 `id` 字段（"花色-点数"），
// 供前端唯一引用具体某一张牌。前端类型的 Card 依赖这个 id。
impl Serialize for Card {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("Card", 3)?;
        s.serialize_field("suit", &self.suit)?;
        s.serialize_field("rank", &self.rank)?;
        s.serialize_field("id", &self.id())?;
        s.end()
    }
}

impl Card {
    pub fn new(suit: Suit, rank: u8) -> Self {
        Card { suit, rank }
    }

    /// 唯一 id，前端用这个引用具体一张牌
    pub fn id(&self) -> String {
        format!("{}-{}", self.suit, self.rank)
    }

    /// 是否是王
    pub fn is_joker(&self) -> bool {
        self.suit == Suit::Joker
    }

    /// 牌的点数文字（用于调试）
    pub fn rank_text(&self) -> String {
        match self.rank {
            16 => "小王".to_string(),
            17 => "大王".to_string(),
            11 => "J".to_string(),
            12 => "Q".to_string(),
            13 => "K".to_string(),
            14 => "A".to_string(),
            r => r.to_string(),
        }
    }
}

impl fmt::Display for Card {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.suit, self.rank_text())
    }
}

/// 生成一副完整的 54 张牌（含大小王）
pub fn full_deck() -> Vec<Card> {
    let mut deck = Vec::with_capacity(54);
    let suits = [Suit::Hearts, Suit::Diamonds, Suit::Clubs, Suit::Spades];
    for suit in suits.iter() {
        for rank in 3..=15 {
            // 3..A(14), 2(15)
            deck.push(Card::new(*suit, rank));
        }
    }
    // 大小王
    deck.push(Card::new(Suit::Joker, 16)); // 小王
    deck.push(Card::new(Suit::Joker, 17)); // 大王
    deck
}

/// 洗牌
pub fn shuffle(deck: &mut Vec<Card>) {
    use rand::seq::SliceRandom;
    let mut rng = rand::thread_rng();
    deck.shuffle(&mut rng);
}
