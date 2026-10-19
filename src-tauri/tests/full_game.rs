// 集成测试：3 个机器人自动打完一局斗地主，验证游戏逻辑闭环
use puke_lib::game::bot::{bot_bid_step, bot_play_step};
use puke_lib::game::engine::{Game, GamePhase, Role};

#[test]
fn test_full_game_bots_only() {
    let mut game = Game::new();
    assert_eq!(game.phase, GamePhase::Bidding);

    // 叫地主阶段
    let mut safety = 0;
    while game.phase == GamePhase::Bidding && safety < 10 {
        bot_bid_step(&mut game).expect("bot bid should succeed");
        safety += 1;
    }
    assert_eq!(game.phase, GamePhase::Playing, "应该进入出牌阶段");

    // 确认地主已确定
    let landlord_count = game.players.iter().filter(|p| p.role == Role::Landlord).count();
    assert_eq!(landlord_count, 1, "应该有且仅有一个地主");

    // 出牌阶段，直到游戏结束
    let mut rounds = 0;
    while game.phase == GamePhase::Playing && rounds < 500 {
        bot_play_step(&mut game).expect("bot play should succeed");
        rounds += 1;
    }

    assert_eq!(game.phase, GamePhase::GameOver, "游戏应该结束");
    assert!(game.winner.is_some(), "应该有获胜方");

    // 验证：获胜方中至少有一个玩家手牌为空
    let winner_role = game.winner.unwrap();
    let has_empty_winner = game
        .players
        .iter()
        .any(|p| p.role == winner_role && p.hand.is_empty());
    assert!(has_empty_winner, "获胜方应该有玩家手牌为空");

    println!(
        "游戏结束！获胜方: {:?}, 总回合数: {}",
        winner_role, rounds
    );
}

#[test]
fn test_multiple_games_no_panic() {
    // 跑 10 局，确保没有 panic
    for i in 0..10 {
        let mut game = Game::new();
        let mut safety = 0;
        while game.phase == GamePhase::Bidding && safety < 10 {
            bot_bid_step(&mut game).unwrap();
            safety += 1;
        }
        let mut rounds = 0;
        while game.phase == GamePhase::Playing && rounds < 500 {
            bot_play_step(&mut game).unwrap();
            rounds += 1;
        }
        assert_eq!(game.phase, GamePhase::GameOver, "第 {} 局应结束", i);
    }
}
