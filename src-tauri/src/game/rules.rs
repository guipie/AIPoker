use crate::game::card::Card;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 牌型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternType {
    Single,
    Pair,
    Triple,
    TripleSingle,
    TriplePair,
    Straight,
    PairStraight,
    Airplane,
    AirplaneSingle,
    AirplanePair,
    FourTwoSingle,
    FourTwoPair,
    Bomb,
    Rocket,
}

/// 识别出的牌型
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardPattern {
    #[serde(rename = "type")]
    pub type_: PatternType,
    pub main_rank: u8,
    pub length: u8,
    pub cards: Vec<Card>,
}

/// 识别一组牌的牌型，不合法返回 None
pub fn detect_pattern(cards: &[Card]) -> Option<CardPattern> {
    if cards.is_empty() {
        return None;
    }
    let n = cards.len();

    // 统计每个点数的张数
    let mut rank_counts: BTreeMap<u8, u8> = BTreeMap::new();
    for c in cards {
        *rank_counts.entry(c.rank).or_insert(0) += 1;
    }

    // 按张数分组
    let mut singles: Vec<u8> = vec![];
    let mut pairs: Vec<u8> = vec![];
    let mut triples: Vec<u8> = vec![];
    let mut quads: Vec<u8> = vec![];
    for (&rank, &count) in rank_counts.iter() {
        match count {
            1 => singles.push(rank),
            2 => pairs.push(rank),
            3 => triples.push(rank),
            4 => quads.push(rank),
            _ => return None,
        }
    }

    // 王炸（大小王）
    if n == 2 {
        let ranks: Vec<u8> = cards.iter().map(|c| c.rank).collect();
        if ranks.contains(&16) && ranks.contains(&17) {
            return Some(CardPattern {
                type_: PatternType::Rocket,
                main_rank: 17,
                length: 1,
                cards: cards.to_vec(),
            });
        }
    }

    // 炸弹（四张相同）
    if n == 4 && quads.len() == 1 {
        return Some(CardPattern {
            type_: PatternType::Bomb,
            main_rank: quads[0],
            length: 1,
            cards: cards.to_vec(),
        });
    }

    match n {
        1 => Some(CardPattern {
            type_: PatternType::Single,
            main_rank: singles[0],
            length: 1,
            cards: cards.to_vec(),
        }),
        2 => {
            if pairs.len() == 1 {
                Some(CardPattern {
                    type_: PatternType::Pair,
                    main_rank: pairs[0],
                    length: 1,
                    cards: cards.to_vec(),
                })
            } else {
                None
            }
        }
        3 => {
            if triples.len() == 1 {
                Some(CardPattern {
                    type_: PatternType::Triple,
                    main_rank: triples[0],
                    length: 1,
                    cards: cards.to_vec(),
                })
            } else {
                None
            }
        }
        4 => {
            // 三带一
            if triples.len() == 1 && singles.len() == 1 {
                Some(CardPattern {
                    type_: PatternType::TripleSingle,
                    main_rank: triples[0],
                    length: 1,
                    cards: cards.to_vec(),
                })
            } else {
                None
            }
        }
        5 => {
            // 三带二 或 五张顺子
            if triples.len() == 1 && pairs.len() == 1 {
                Some(CardPattern {
                    type_: PatternType::TriplePair,
                    main_rank: triples[0],
                    length: 1,
                    cards: cards.to_vec(),
                })
            } else if singles.len() == 5 && is_consecutive(&singles) && *singles.last().unwrap() <= 14 {
                Some(CardPattern {
                    type_: PatternType::Straight,
                    main_rank: *singles.last().unwrap(),
                    length: 5,
                    cards: cards.to_vec(),
                })
            } else {
                None
            }
        }
        _ => {
            // 6 张及以上
            // 四带二单：4 + 1 + 1
            if n == 6 && quads.len() == 1 && singles.len() == 2 {
                return Some(CardPattern {
                    type_: PatternType::FourTwoSingle,
                    main_rank: quads[0],
                    length: 1,
                    cards: cards.to_vec(),
                });
            }
            // 四带二对：4 + 2 + 2
            if n == 8 && quads.len() == 1 && pairs.len() == 2 {
                return Some(CardPattern {
                    type_: PatternType::FourTwoPair,
                    main_rank: quads[0],
                    length: 1,
                    cards: cards.to_vec(),
                });
            }
            // 连对：3+ 连续对子
            if pairs.len() >= 3
                && is_consecutive(&pairs)
                && *pairs.last().unwrap() <= 14
                && n == pairs.len() * 2
            {
                return Some(CardPattern {
                    type_: PatternType::PairStraight,
                    main_rank: *pairs.last().unwrap(),
                    length: pairs.len() as u8,
                    cards: cards.to_vec(),
                });
            }
            // 顺子：5+ 连续单张
            if singles.len() >= 5
                && is_consecutive(&singles)
                && *singles.last().unwrap() <= 14
                && n == singles.len()
            {
                return Some(CardPattern {
                    type_: PatternType::Straight,
                    main_rank: *singles.last().unwrap(),
                    length: singles.len() as u8,
                    cards: cards.to_vec(),
                });
            }
            // 飞机：2+ 连续三张
            if triples.len() >= 2 && is_consecutive(&triples) && *triples.last().unwrap() <= 14 {
                let t_len = triples.len();
                if n == t_len * 3 {
                    return Some(CardPattern {
                        type_: PatternType::Airplane,
                        main_rank: *triples.last().unwrap(),
                        length: t_len as u8,
                        cards: cards.to_vec(),
                    });
                }
                if n == t_len * 4 && singles.len() == t_len {
                    return Some(CardPattern {
                        type_: PatternType::AirplaneSingle,
                        main_rank: *triples.last().unwrap(),
                        length: t_len as u8,
                        cards: cards.to_vec(),
                    });
                }
                if n == t_len * 5 && pairs.len() == t_len {
                    return Some(CardPattern {
                        type_: PatternType::AirplanePair,
                        main_rank: *triples.last().unwrap(),
                        length: t_len as u8,
                        cards: cards.to_vec(),
                    });
                }
            }
            None
        }
    }
}

/// 判断 new 牌型能否压过 last 牌型
pub fn can_beat(new: &CardPattern, last: &CardPattern) -> bool {
    use PatternType::*;
    // 王炸最大
    if new.type_ == Rocket {
        return true;
    }
    if last.type_ == Rocket {
        return false;
    }
    // 炸弹
    if new.type_ == Bomb {
        if last.type_ == Bomb {
            return new.main_rank > last.main_rank;
        }
        return true; // 炸弹压任何非炸弹非王炸
    }
    if last.type_ == Bomb {
        return false;
    }
    // 普通牌型：类型相同、长度相同，比较主点数
    if new.type_ != last.type_ || new.length != last.length {
        return false;
    }
    new.main_rank > last.main_rank
}

/// 检查一组已排序的点数是否连续
fn is_consecutive(ranks: &[u8]) -> bool {
    if ranks.len() < 2 {
        return true;
    }
    for w in ranks.windows(2) {
        if w[1] != w[0] + 1 {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::card::{Card, Suit};

    fn c(suit: Suit, rank: u8) -> Card {
        Card::new(suit, rank)
    }

    #[test]
    fn test_single() {
        let p = detect_pattern(&[c(Suit::Hearts, 5)]).unwrap();
        assert_eq!(p.type_, PatternType::Single);
        assert_eq!(p.main_rank, 5);
    }

    #[test]
    fn test_pair() {
        let p = detect_pattern(&[c(Suit::Hearts, 5), c(Suit::Diamonds, 5)]).unwrap();
        assert_eq!(p.type_, PatternType::Pair);
    }

    #[test]
    fn test_triple() {
        let p = detect_pattern(&[c(Suit::Hearts, 5), c(Suit::Diamonds, 5), c(Suit::Clubs, 5)]).unwrap();
        assert_eq!(p.type_, PatternType::Triple);
    }

    #[test]
    fn test_triple_single() {
        let p = detect_pattern(&[
            c(Suit::Hearts, 5),
            c(Suit::Diamonds, 5),
            c(Suit::Clubs, 5),
            c(Suit::Spades, 7),
        ])
        .unwrap();
        assert_eq!(p.type_, PatternType::TripleSingle);
        assert_eq!(p.main_rank, 5);
    }

    #[test]
    fn test_triple_pair() {
        let p = detect_pattern(&[
            c(Suit::Hearts, 5),
            c(Suit::Diamonds, 5),
            c(Suit::Clubs, 5),
            c(Suit::Spades, 7),
            c(Suit::Hearts, 7),
        ])
        .unwrap();
        assert_eq!(p.type_, PatternType::TriplePair);
    }

    #[test]
    fn test_straight() {
        let p = detect_pattern(&[
            c(Suit::Hearts, 3),
            c(Suit::Diamonds, 4),
            c(Suit::Clubs, 5),
            c(Suit::Spades, 6),
            c(Suit::Hearts, 7),
        ])
        .unwrap();
        assert_eq!(p.type_, PatternType::Straight);
        assert_eq!(p.main_rank, 7);
        assert_eq!(p.length, 5);
    }

    #[test]
    fn test_straight_with_2_invalid() {
        // 顺子不能包含 2
        let p = detect_pattern(&[
            c(Suit::Hearts, 11),
            c(Suit::Diamonds, 12),
            c(Suit::Clubs, 13),
            c(Suit::Spades, 14),
            c(Suit::Hearts, 15),
        ]);
        assert!(p.is_none());
    }

    #[test]
    fn test_pair_straight() {
        let cards = vec![
            c(Suit::Hearts, 3), c(Suit::Diamonds, 3),
            c(Suit::Clubs, 4), c(Suit::Spades, 4),
            c(Suit::Hearts, 5), c(Suit::Diamonds, 5),
        ];
        let p = detect_pattern(&cards).unwrap();
        assert_eq!(p.type_, PatternType::PairStraight);
        assert_eq!(p.length, 3);
    }

    #[test]
    fn test_airplane() {
        let cards = vec![
            c(Suit::Hearts, 5), c(Suit::Diamonds, 5), c(Suit::Clubs, 5),
            c(Suit::Spades, 6), c(Suit::Hearts, 6), c(Suit::Diamonds, 6),
        ];
        let p = detect_pattern(&cards).unwrap();
        assert_eq!(p.type_, PatternType::Airplane);
        assert_eq!(p.length, 2);
    }

    #[test]
    fn test_bomb() {
        let cards = vec![
            c(Suit::Hearts, 7),
            c(Suit::Diamonds, 7),
            c(Suit::Clubs, 7),
            c(Suit::Spades, 7),
        ];
        let p = detect_pattern(&cards).unwrap();
        assert_eq!(p.type_, PatternType::Bomb);
        assert_eq!(p.main_rank, 7);
    }

    #[test]
    fn test_rocket() {
        let cards = vec![c(Suit::Joker, 16), c(Suit::Joker, 17)];
        let p = detect_pattern(&cards).unwrap();
        assert_eq!(p.type_, PatternType::Rocket);
    }

    #[test]
    fn test_four_two_single() {
        let cards = vec![
            c(Suit::Hearts, 7), c(Suit::Diamonds, 7), c(Suit::Clubs, 7), c(Suit::Spades, 7),
            c(Suit::Hearts, 3), c(Suit::Diamonds, 5),
        ];
        let p = detect_pattern(&cards).unwrap();
        assert_eq!(p.type_, PatternType::FourTwoSingle);
    }

    #[test]
    fn test_can_beat() {
        let bomb = CardPattern {
            type_: PatternType::Bomb,
            main_rank: 7,
            length: 1,
            cards: vec![],
        };
        let single = CardPattern {
            type_: PatternType::Single,
            main_rank: 14,
            length: 1,
            cards: vec![],
        };
        assert!(can_beat(&bomb, &single));
        assert!(!can_beat(&single, &bomb));

        let rocket = CardPattern {
            type_: PatternType::Rocket,
            main_rank: 17,
            length: 1,
            cards: vec![],
        };
        assert!(can_beat(&rocket, &bomb));

        let s3 = CardPattern {
            type_: PatternType::Straight,
            main_rank: 7,
            length: 5,
            cards: vec![],
        };
        let s5 = CardPattern {
            type_: PatternType::Straight,
            main_rank: 8,
            length: 5,
            cards: vec![],
        };
        assert!(can_beat(&s5, &s3));
        assert!(!can_beat(&s3, &s5));
    }
}
