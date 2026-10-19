use crate::game::card::Card;
use crate::game::engine::{Game, Role};
use crate::game::rules::{CardPattern, PatternType};

/// 机器人叫地主决策：根据手牌强度返回 0/1/2/3 分
pub fn decide_bid(hand: &[Card]) -> u8 {
    let mut score = 0;
    // 大王 +2，小王 +1
    if hand.iter().any(|c| c.rank == 17) {
        score += 2;
    }
    if hand.iter().any(|c| c.rank == 16) {
        score += 1;
    }
    // 每个 2 +1
    score += hand.iter().filter(|c| c.rank == 15).count() as u8;
    // 炸弹 +3
    let bombs = count_bombs(hand);
    score += bombs * 3;

    // 映射到 0-3 分
    if score >= 6 {
        3
    } else if score >= 4 {
        2
    } else if score >= 2 {
        1
    } else {
        0
    }
}

fn count_bombs(hand: &[Card]) -> u8 {
    use std::collections::HashMap;
    let mut counts: HashMap<u8, u8> = HashMap::new();
    for c in hand {
        *counts.entry(c.rank).or_insert(0) += 1;
    }
    counts.values().filter(|&&v| v == 4).count() as u8
}

/// 机器人出牌决策
/// 返回 Some(cards) 表示出牌，None 表示不出
pub fn decide_play(hand: &[Card], last_play: Option<&CardPattern>, last_player_role: Role, my_role: Role, teammate_hand_count: usize) -> Option<Vec<Card>> {
    match last_play {
        None => {
            // 首家：出最小的牌型
            Some(first_play(hand))
        }
        Some(last) => {
            // 如果是队友出的牌，且队友手牌少（快赢了），则不出
            if is_teammate(my_role, last_player_role) && teammate_hand_count <= 2 {
                return None;
            }
            // 找能压过的最小牌型
            find_min_beat(hand, last)
        }
    }
}

fn is_teammate(my_role: Role, other_role: Role) -> bool {
    // 农民之间是队友
    my_role == Role::Farmer && other_role == Role::Farmer
}

/// 首家出牌：优先出最小的单张；如果手牌少且有对子出对子
fn first_play(hand: &[Card]) -> Vec<Card> {
    if hand.len() == 1 {
        return hand.to_vec();
    }
    // 找最小的单张（排除王和2，尽量先出小牌）
    let mut sorted: Vec<Card> = hand.to_vec();
    sorted.sort_by_key(|c| c.rank);

    // 优先出不是 2/王 的最小单张
    if let Some(c) = sorted.iter().find(|c| c.rank < 15) {
        return vec![*c];
    }
    // 否则出最小单张
    vec![sorted[0]]
}

/// 找能压过 last 的最小牌型，找不到返回 None
fn find_min_beat(hand: &[Card], last: &CardPattern) -> Option<Vec<Card>> {
    use PatternType::*;
    let result = match last.type_ {
        Single => find_min_single(hand, last.main_rank),
        Pair => find_min_pair(hand, last.main_rank),
        Triple => find_min_triple(hand, last.main_rank),
        TripleSingle => find_min_triple_single(hand, last.main_rank),
        TriplePair => find_min_triple_pair(hand, last.main_rank),
        Straight => find_min_straight(hand, last.main_rank, last.length),
        PairStraight => find_min_pair_straight(hand, last.main_rank, last.length),
        Airplane => find_min_airplane(hand, last.main_rank, last.length),
        AirplaneSingle => find_min_airplane_single(hand, last.main_rank, last.length),
        AirplanePair => find_min_airplane_pair(hand, last.main_rank, last.length),
        FourTwoSingle => find_min_four_two_single(hand, last.main_rank),
        FourTwoPair => find_min_four_two_pair(hand, last.main_rank),
        Bomb => find_min_bomb(hand, last.main_rank),
        Rocket => None, // 王炸压不过
    };

    if result.is_some() {
        return result;
    }

    // 普通牌型压不过，尝试用炸弹
    if last.type_ != Bomb && last.type_ != Rocket {
        if let Some(bomb) = find_min_bomb(hand, 0) {
            return Some(bomb);
        }
    }
    // 最后尝试王炸
    find_rocket(hand)
}

// ---- 各种牌型的最小跟牌 ----

fn ranks_by_count(hand: &[Card]) -> std::collections::BTreeMap<u8, Vec<Card>> {
    let mut m: std::collections::BTreeMap<u8, Vec<Card>> = std::collections::BTreeMap::new();
    for c in hand {
        m.entry(c.rank).or_default().push(*c);
    }
    m
}

fn find_min_single(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && !cards.is_empty() {
            return Some(vec![cards[0]]);
        }
    }
    None
}

fn find_min_pair(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 2 {
            return Some(cards[..2].to_vec());
        }
    }
    None
}

fn find_min_triple(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 3 {
            return Some(cards[..3].to_vec());
        }
    }
    None
}

fn find_min_triple_single(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 3 {
            // 找一张最小的单牌带（不能是这个 rank 本身）
            let kicker = m
                .iter()
                .filter(|(&r, _)| r != rank)
                .flat_map(|(_, cs)| cs.iter().next())
                .min_by_key(|c| c.rank)
                .copied();
            if let Some(k) = kicker {
                let mut out = cards[..3].to_vec();
                out.push(k);
                return Some(out);
            }
        }
    }
    None
}

fn find_min_triple_pair(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 3 {
            // 找一个最小的对子带
            let kicker = m
                .iter()
                .filter(|(&r, _)| r != rank)
                .filter(|(_, cs)| cs.len() >= 2)
                .min_by_key(|(&r, _)| r)
                .map(|(_, cs)| cs[..2].to_vec());
            if let Some(k) = kicker {
                let mut out = cards[..3].to_vec();
                out.extend(k);
                return Some(out);
            }
        }
    }
    None
}

fn find_min_straight(hand: &[Card], min_main_rank: u8, length: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    let avail_ranks: Vec<u8> = m.keys().filter(|&&r| r <= 14 && r >= 3).copied().collect();
    // 找长度为 length 的连续段，且最大值 > min_main_rank
    let len = length as usize;
    if avail_ranks.len() < len {
        return None;
    }
    for start in 0..=(avail_ranks.len() - len) {
        let seg = &avail_ranks[start..start + len];
        if seg[len - 1] <= min_main_rank {
            continue;
        }
        // 检查连续
        let mut consecutive = true;
        for w in seg.windows(2) {
            if w[1] != w[0] + 1 {
                consecutive = false;
                break;
            }
        }
        if consecutive {
            let mut out = vec![];
            for &r in seg {
                out.push(m[&r][0]);
            }
            return Some(out);
        }
    }
    None
}

fn find_min_pair_straight(hand: &[Card], min_main_rank: u8, length: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    let pair_ranks: Vec<u8> = m
        .iter()
        .filter(|(&r, cs)| r <= 14 && cs.len() >= 2)
        .map(|(&r, _)| r)
        .collect();
    let len = length as usize;
    if pair_ranks.len() < len {
        return None;
    }
    for start in 0..=(pair_ranks.len() - len) {
        let seg = &pair_ranks[start..start + len];
        if seg[len - 1] <= min_main_rank {
            continue;
        }
        let mut consecutive = true;
        for w in seg.windows(2) {
            if w[1] != w[0] + 1 {
                consecutive = false;
                break;
            }
        }
        if consecutive {
            let mut out = vec![];
            for &r in seg {
                out.extend(m[&r][..2].to_vec());
            }
            return Some(out);
        }
    }
    None
}

fn find_min_airplane(hand: &[Card], min_main_rank: u8, length: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    let triple_ranks: Vec<u8> = m
        .iter()
        .filter(|(&r, cs)| r <= 14 && cs.len() >= 3)
        .map(|(&r, _)| r)
        .collect();
    let len = length as usize;
    if triple_ranks.len() < len {
        return None;
    }
    for start in 0..=(triple_ranks.len() - len) {
        let seg = &triple_ranks[start..start + len];
        if seg[len - 1] <= min_main_rank {
            continue;
        }
        let mut consecutive = true;
        for w in seg.windows(2) {
            if w[1] != w[0] + 1 {
                consecutive = false;
                break;
            }
        }
        if consecutive {
            let mut out = vec![];
            for &r in seg {
                out.extend(m[&r][..3].to_vec());
            }
            return Some(out);
        }
    }
    None
}

fn find_min_airplane_single(hand: &[Card], min_main_rank: u8, length: u8) -> Option<Vec<Card>> {
    // 先找飞机主体
    let m = ranks_by_count(hand);
    let triple_ranks: Vec<u8> = m
        .iter()
        .filter(|(&r, cs)| r <= 14 && cs.len() >= 3)
        .map(|(&r, _)| r)
        .collect();
    let len = length as usize;
    if triple_ranks.len() < len {
        return None;
    }
    for start in 0..=(triple_ranks.len() - len) {
        let seg = &triple_ranks[start..start + len];
        if seg[len - 1] <= min_main_rank {
            continue;
        }
        let mut consecutive = true;
        for w in seg.windows(2) {
            if w[1] != w[0] + 1 {
                consecutive = false;
                break;
            }
        }
        if consecutive {
            // 找 len 张最小的单牌作为翅膀（不能是飞机主体的 rank）
            let seg_set: std::collections::HashSet<u8> = seg.iter().copied().collect();
            let mut kickers: Vec<Card> = hand
                .iter()
                .filter(|c| !seg_set.contains(&c.rank))
                .copied()
                .collect();
            kickers.sort_by_key(|c| c.rank);
            if kickers.len() >= len {
                let mut out = vec![];
                for &r in seg {
                    out.extend(m[&r][..3].to_vec());
                }
                out.extend(kickers[..len].to_vec());
                return Some(out);
            }
        }
    }
    None
}

fn find_min_airplane_pair(hand: &[Card], min_main_rank: u8, length: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    let triple_ranks: Vec<u8> = m
        .iter()
        .filter(|(&r, cs)| r <= 14 && cs.len() >= 3)
        .map(|(&r, _)| r)
        .collect();
    let len = length as usize;
    if triple_ranks.len() < len {
        return None;
    }
    for start in 0..=(triple_ranks.len() - len) {
        let seg = &triple_ranks[start..start + len];
        if seg[len - 1] <= min_main_rank {
            continue;
        }
        let mut consecutive = true;
        for w in seg.windows(2) {
            if w[1] != w[0] + 1 {
                consecutive = false;
                break;
            }
        }
        if consecutive {
            let seg_set: std::collections::HashSet<u8> = seg.iter().copied().collect();
            // 找 len 个最小的对子作为翅膀
            let mut available_pairs: Vec<(u8, Vec<Card>)> = m
                .iter()
                .filter(|(&r, cs)| !seg_set.contains(&r) && cs.len() >= 2)
                .map(|(&r, cs)| (r, cs[..2].to_vec()))
                .collect();
            available_pairs.sort_by_key(|(r, _)| *r);
            if available_pairs.len() >= len {
                let mut out = vec![];
                for &r in seg {
                    out.extend(m[&r][..3].to_vec());
                }
                for (_, p) in available_pairs.iter().take(len) {
                    out.extend(p.clone());
                }
                return Some(out);
            }
        }
    }
    None
}

fn find_min_four_two_single(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 4 {
            // 找两张最小的单牌
            let mut kickers: Vec<Card> = hand
                .iter()
                .filter(|c| c.rank != rank)
                .copied()
                .collect();
            kickers.sort_by_key(|c| c.rank);
            if kickers.len() >= 2 {
                let mut out = cards[..4].to_vec();
                out.extend(kickers[..2].to_vec());
                return Some(out);
            }
        }
    }
    None
}

fn find_min_four_two_pair(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() >= 4 {
            let mut pairs: Vec<(u8, Vec<Card>)> = m
                .iter()
                .filter(|(&r, cs)| r != rank && cs.len() >= 2)
                .map(|(&r, cs)| (r, cs[..2].to_vec()))
                .collect();
            pairs.sort_by_key(|(r, _)| *r);
            if pairs.len() >= 2 {
                let mut out = cards[..4].to_vec();
                out.extend(pairs[0].1.clone());
                out.extend(pairs[1].1.clone());
                return Some(out);
            }
        }
    }
    None
}

fn find_min_bomb(hand: &[Card], min_rank: u8) -> Option<Vec<Card>> {
    let m = ranks_by_count(hand);
    for (&rank, cards) in m.iter() {
        if rank > min_rank && cards.len() == 4 {
            return Some(cards[..4].to_vec());
        }
    }
    None
}

fn find_rocket(hand: &[Card]) -> Option<Vec<Card>> {
    let small = hand.iter().find(|c| c.rank == 16);
    let big = hand.iter().find(|c| c.rank == 17);
    match (small, big) {
        (Some(s), Some(b)) => Some(vec![*s, *b]),
        _ => None,
    }
}

/// 辅助：让机器人执行一次叫地主
pub fn bot_bid_step(game: &mut Game) -> Result<(), String> {
    let pid = game.current_player;
    let hand = game.players[pid].hand.clone();
    let desire = decide_bid(&hand);
    // 只能叫比当前最高分高的分，否则不叫
    let score = if desire > game.current_bid { desire } else { 0 };
    game.bid(pid, score)
}

/// 辅助：让机器人执行一次出牌
pub fn bot_play_step(game: &mut Game) -> Result<(), String> {
    let pid = game.current_player;
    let hand = game.players[pid].hand.clone();
    let my_role = game.players[pid].role;
    let last_player_role = game
        .last_player
        .map(|lp| game.players[lp].role)
        .unwrap_or(Role::Unknown);

    // 队友手牌数（如果我是农民，队友是另一个农民）
    let teammate_hand_count = if my_role == Role::Farmer {
        game.players
            .iter()
            .find(|p| p.id != pid && p.role == Role::Farmer)
            .map(|p| p.hand.len())
            .unwrap_or(0)
    } else {
        0
    };

    let last_play = game.last_play.as_ref();
    match decide_play(&hand, last_play, last_player_role, my_role, teammate_hand_count) {
        Some(cards) => game.play(pid, &cards),
        None => game.pass(pid),
    }
}
