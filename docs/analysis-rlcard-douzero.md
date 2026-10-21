# RLCard / DouZero 技术分析

> 面向 AIPoker 项目的可落地评估。数据采集于 2026-10-21。

## 0. 一句话结论

**这两个项目不是竞品，而是「环境层」与「策略层」：RLCard 提供可比对的标准牌局环境，DouZero 提供斗地主的最强策略。**
对 AIPoker 而言，RLCard 的价值是一份可直译的规则 AI 参考实现 + 环境 API 设计范本；DouZero 的价值是**目前唯一能给我们提供「真正强敌」的来源**，且它的决策架构与我们引擎已有的候选枚举能力天然契合。

但它们都**不能**解决 AIPoker 的核心卖点（看 LLM 打牌），只能补"对手强度"和"决策评价"这两块。

---

## 1. 基本盘

| 维度 | datamllab/rlcard | kwai/DouZero |
|---|---|---|
| 定位 | 卡牌游戏 RL **工具包 / 基准框架** | 单一游戏（斗地主）的 **SOTA 策略** |
| 出身 | Rice + Texas A&M，IJCAI 2020 | 快手 AI 平台，ICML 2021 |
| Star / Fork | 3,580 / 751 | 4,686 / 650 |
| 许可证 | MIT | Apache-2.0 |
| 语言 | Python | Python (PyTorch) |
| 最后提交 | 2024-06 | 2024-06 |
| 规模 | 8.6 MB，9 种游戏环境 | 189 KB，纯策略代码（无权重） |
| 依赖 | numpy（可选 torch） | torch + numpy，训练需 CUDA |

两者都已进入**低频维护**状态（2024 年中之后基本停更），但作为研究代码足够稳定，API 不会变。

---

## 2. RLCard：环境抽象做得很好，策略做得一般

### 2.1 分层结构

```
rlcard/
├── games/      # 纯游戏逻辑（发牌、规则、结算），无 RL 概念
├── envs/       # 环境包装：状态编码、动作编码、合法性过滤
├── agents/     # 算法实现（CFR / DQN / NFSP / DMC）
└── models/     # 预训练模型 + 规则模型（model zoo）
```

**值得学的设计**：`games` 与 `envs` 严格分离。游戏引擎不认识"tensor"，只吐结构化状态；环境层负责把状态压成网络能吃的数组。我们现在的 `src/engine/doudizhu.ts` 是**引擎和决策 AI 混在一起**（`suggestLead` / `findBeats` 直接住在引擎文件里），这正是接 RL 时会碍事的地方。

### 2.2 状态契约

```python
state = {
  'obs':               # 给网络的编码（numpy array）
  'legal_actions':     # 合法动作（int）
  'raw_obs':           # 人类可读的原始状态（dict）
  'raw_legal_actions': # 人类可读的合法动作（str）
}
```

`raw_*` 与编码态并存是个很实用的设计——调试和 LLM 提示都用得上 raw 态。我们的 `getState()` 目前只有 raw 态（好事，LLM 用），接 RL 时补一个 `encode()` 即可。

### 2.3 九种环境的复杂度（决定"能不能训得动"）

| 游戏 | 信息集数量 | 动作空间 | 难度 |
|---|---|---|---|
| Blackjack | 10³ | 10⁰ | 玩具 |
| Leduc Hold'em | 10² | 10⁰ | 教学 |
| Limit Texas Hold'em | 10¹⁴ | 10⁰ | 中 |
| **Dou Dizhu** | **10⁵³ ~ 10⁸³** | **10⁴** | **极难** |
| Mahjong | 10¹²¹ | 10² | 极难 |
| **No-limit Texas Hold'em** | **10¹⁶²** | **10⁴** | **未解** |
| UNO | 10¹⁶³ | 10¹ | 极难 |

这张表解释了一件重要的事：**为什么无限注德州没有强开源 AI**。10¹⁶² 的信息集比斗地主还大 80 个数量级，学界公认未解（Libratus/Pluribus 是限定人数的特化系统，不是通用库）。所以 AIPoker 的德州牌桌，短期内**不可能**像斗地主那样接一个 DouZero 级别的对手。

### 2.4 算法与模型库

支持 CFR（反事实 regret 最小化，适合小游戏）、DQN、NFSP、DMC（DouZero 的算法，后被回灌进 RLCard）。

模型库里的规则模型对我们最有用：

| 模型 | 说明 | 可移植性 |
|---|---|---|
| `doudizhu-rule-v1` | 斗地主规则 AI，**6.3 KB / 约 200 行 Python** | ★★★★★ 可直译 TS |
| `leduc-holdem-cfr` | Leduc 预训练 CFR | ★★ 需要推理框架 |
| `limitholdem-rule-v1` | **限注**德州规则 AI | ★★★ 可参考，非无限注 |

注意：**没有无限注德州的规则模型**。德州那块 RLCard 帮不上。

---

## 3. DouZero：真正的贡献是「怎么绕过巨大动作空间」

### 3.1 问题

斗地主每回合的合法动作**完全取决于当前手牌和上家出牌**，数量从 1 个到上百个不等。标准 DQN 要求输出固定维度的 Q 向量，这里根本没法定义输出层。

### 3.2 解法（这才是论文的核心）

```
① 枚举所有合法动作        MovesGener ──→ [a1, a2, ..., aN]
② 对每个候选拼 (状态, 动作)  x_batch: (N, 373)   ← 每个候选一份完整特征
③ 网络输出 N 个标量        Q(s,a1), Q(s,a2), ...
④ 取 argmax               ← 一次 forward 打完所有候选
```

网络结构极其朴素：

```python
LSTM(162 → 128)            # 历史动作序列（z）
concat(lstm_out, x)        # → 373+128 = 501 (地主) / 484+128 = 612 (农民)
Linear(501 → 512) × 5      # 5 层 MLP，ReLU
Linear(512 → 1)            # 单个 Q 值
```

参数量：地主 ≈ 1.46 M，农民 ≈ 1.52 M，**三个模型合计 ≈ 4.5 M**（fp32 约 18 MB，int8 量化约 4.5 MB）。
对比：一个 7B 的 LLM 是它的 **1500 倍**。

### 3.3 三个值得抄的设计细节

1. **不做动作分类，做动作打分**。因为打分器的输入包含动作本身，模型天然支持任意可变数量的候选。这套架构（现在叫 pointer / action-scoring）后来成了大动作空间博弈的标准做法。
2. **LSTM 编码历史**而不是把历史拍平成特征。162 维 = 最近若干轮的动作序列，让模型能感知"对手连着放过三次"这类节奏信息。
3. **两个训练目标**：ADP（平均分差，激进赚分）和 WP（胜率，稳健求赢）。同架构两种性格，可以直接当两个不同难度的对手。

### 3.4 效果

论文称：单机 4 卡、数天自对弈，超越所有已有斗地主 AI，在 Botzone 344 个 agent 中排名第一。官方 demo 提供 ONNX 推理路径，10-20 个候选的决策耗时 **50-200 ms**（CPU）。

---

## 4. 两者的真实关系

```
RLCard  ──提供环境──→  DouZero 训练时用的评估基线（rlcard_agent）
   ↑                          │
   └──── DMC 算法回灌 ────────┘
```

DouZero 的 `evaluate.py` 里，`--landlord rlcard` 就是直接调 RLCard 的规则 agent 当对手。所以**这俩是同一批人（Daochen Zha 等）的两个项目**，设计上互为补充：
- RLCard 解决"怎么公平地比较不同 AI"
- DouZero 解决"斗地主到底怎么打到最强"

DouZero 的 GUI demo（`rlcard-showdown`）也是基于 RLCard 的。

---

## 5. 与 AIPoker 现状对照

| 维度 | AIPoker 现在 | RLCard | DouZero |
|---|---|---|---|
| 引擎 | 纯 TS，浏览器可跑 | Python | Python |
| 决策来源 | LLM（主力）+ 手写启发式 | 4 种 RL 算法 + 规则模型 | 单一 DMC 策略 |
| 可解释性 | **强**（LLM 给中文理由） | 弱（Q 值/策略表） | 弱（Q 值） |
| 人格差异 | **强**（8 个 agent 各有 persona） | 无 | 无（仅 ADP/WP 两档） |
| 牌力强度 | 弱—中 | 弱（规则）/ 中（训练后） | **强（超人类）** |
| 决策延迟 | 1-10 s（网络） | <1 ms | 50-200 ms |
| 运行成本 | 按 token 付费 | 免费 | 免费（本地推理） |
| 多人局支持 | 3 人 + 4 人（12+4，无王） | 仅 3 人标准局 | **仅 3 人标准局** |
| 德州 | 有（无限注） | 有限注规则模型，无限注只有环境 | 不支持 |

**最关键的一点**：我们的 `findAllBeats()` / `suggestLead()` **已经在做 DouZero 的第 ① 步（枚举候选）**。缺的只是第 ②③④ 步（编码 + 打分 + 选择）。这意味着接入门槛远低于"从零接一个 RL 系统"。

---

## 6. 三条落地路径（按投入排序）

### L1 · 移植 RLCard 规则模型（0.5-1 天，零新依赖）

**做什么**：把 `rlcard/models/doudizhu_rule_models.py`（6.3 KB）直译成 `src/engine/policies/RulePolicy.ts`，替换现在 `suggestLead` 里的粗糙策略（"优先出最小单张/对子"）。

**收益**：
- 现在的规则 AI 只会在"能压就压最小的"层面，残局能力几乎为零。RLCard 的规则模型会拆牌、会算剩余、会配合队友。
- 它同时也是 DouZero 论文里的基线之一，接完之后我们有了**可对比的锚点**。

**风险**：低。纯逻辑、无依赖、可单元测试。

**注意**：它是"最弱基线"，别指望它能打。它的价值是**比我们手写的强**，可作为"新手/普通"难度。

### L2 · 接入 DouZero 权重（3-5 天，中等）

**做什么**：

1. 拿权重（唯一障碍）：官方只放了 Google Drive / 百度网盘（提取码 4624），没有直链。需要手动下一次，或找社区 HuggingFace 镜像。
2. `torch.onnx.export` 导出三个模型 → `public/models/douzero/*.onnx`
3. `npm i onnxruntime-web`，在 **Web Worker** 里跑（避免阻塞牌桌动画）
4. 写 `DouZeroPolicy.ts`：
   - `encodeObs(state)`：把我们的 `DdzState` 映射成 373/484 维
     - `my_handcards` 54 维（4×15 牌矩阵拍平）
     - `other_handcards` 54（对手手牌，未知部分置零）
     - `last_action` 54
     - `landlord_up/down_played_cards` 各 54
     - `landlord_up/down_num_cards_left` 各 17（one-hot）
     - `bomb_num` 15（one-hot）
     - `my_action` 54（每个候选一份）
   - `z` 历史序列：需要维护最近 N 步的动作序列（162 / 32 = 5 步，每步 32 维）
5. 把 `argmax` 结果映射回我们的 `Card[]`

**主要工作量在 `encodeObs`**：要把引擎状态严格对齐论文 Table 4。这是纯映射工作，无算法风险，但**必须逐字段核对**，错一位就全盘失效。

**边界问题（必须先想清）**：
- DouZero **只支持 3 人标准局**（17+3 底牌、含大小王）。我们的 4 人局（12+4、无王）**无法使用**，只能回退规则 AI。
- DouZero 假设地主先手、位置固定。我们引擎里人类固定 0 号位，需要在编码时做视角转换。

**包体积**：int8 量化后约 4.5 MB，可接受；但 Tauri 安装包会因此变大。

### L3 · 自己训练（不建议）

需要 4 卡 GPU + 数天。且 AIPoker 的卖点是"看 LLM 打牌"，不是"我们训了个 SOTA 斗地主 AI"——投入产出比不成立。

**唯一值得训练的场景**：想支持我们的 4 人局（无王、12+4）。DouZero 的代码可以改环境支持，但需要重训，成本同 L3。

---

## 7. 真正该先做的事：策略抽象

现在两个牌桌视图里，"LLM 决策 + 规则兜底"是写成 `if/else` 分支的（上次重构遗留的技术债）：

```ts
if (shouldUseLlm(agent)) { ...llmPass / llmUsed 一堆标记... }
else if (llmPass && s.lastPlay) { ... }
else { /* 规则 AI 兜底 */ }
```

直接往里塞第三种（RL）会让这段代码彻底不可维护。正确顺序是**先抽象，再接入**：

```ts
interface DecisionPolicy {
  readonly id: "rule" | "llm" | "rl";
  decide(ctx: DdzContext): Promise<Decision>;   // 永不抛错，失败返回 fallback 标记
}

class RulePolicy implements DecisionPolicy { ... }      // 已有逻辑，挪进来
class LlmPolicy  implements DecisionPolicy { ... }      // 已有逻辑，挪进来
class RlPolicy   implements DecisionPolicy { ... }      // L2 新增
class FallbackPolicy implements DecisionPolicy {        // 装饰器：主策略失败→兜底
  constructor(primary: DecisionPolicy, fallback: DecisionPolicy) {}
}
```

这样：
- 接入 DouZero 只需新增一个类，视图一行不改；
- "LLM 失败回退规则"的逻辑收进 `FallbackPolicy`，两个视图各删约 40 行；
- 每种策略可独立单测（不用起浏览器）；
- 顺带解决了上次遗留的"策略没多态"问题。

**这个抽象做完，L1 和 L2 都只是加一个实现类。** 建议先做这步。

---

## 8. 产品视角：这两个项目能带来的不只是"更强的 AI"

按投入产出排序，我认为价值依次是：

1. **强敌对照（最高价值）**：让 LLM agent 和 DouZero 同桌打一局，"GPT/DeepSeek 能不能打赢专业斗地主 AI"是个天然有传播力的话题。这比再多调几轮 prompt 更能体现产品差异。
2. **复盘教练**：用 DouZero 的 Q 值给 LLM 的每一手决策打分，标出"这手 LLM 亏了 0.3 分"。这直接把"看 AI 打牌"升级成"看 AI 被评判"，也是现有 `matchLog` 明细的自然延伸（每条记录多一列 `qDelta`）。
3. **难度阶梯**：目前 8 个 agent 的"强度"其实都靠 prompt 人设撑，没有真实梯度。接入后可以有：新手（规则）→ 普通（LLM）→ 职业（DouZero-ADP）→ 地狱（DouZero-WP）。
4. **下限保证**：LLM 调用失败时，兜底不再是"出最小的牌"，而是一个真正的强手。

**需要克制的地方**：DouZero 没有人格、不会说话、不会给理由。它是"对手"不是"角色"。别把它包装成 agent 广场里的一员——那会破坏产品"每个 AI 都有性格"的设定。它更适合出现在"挑战模式 / 教练模式"里。

---

## 9. 合规与工程风险

| 项 | 结论 |
|---|---|
| 许可证 | RLCard MIT、DouZero Apache-2.0，**都可商用**；Apache-2.0 需保留 LICENSE 与 NOTICE，并在「关于」页声明 |
| 权重分发 | 官方权重无直链、托管在网盘；再分发条款未明确说明，建议**只本地使用，不打包进安装包**（首次使用时引导下载） |
| 维护状态 | 两者 2024-06 后停更，但不影响离线推理；若用 `pip install douzero` 需锁版本 |
| 4 人局 | **不支持**，必须保留规则 AI 兜底路径 |
| 德州 | **不支持**，德州牌桌维持现状（这是物理限制，不是工程选择） |
| Windows | DouZero 训练在 Windows 上 GPU actor 不可用（CUDA tensor 多进程限制），但**推理没问题** |

---

## 10. 建议的执行顺序

1. **抽出 `DecisionPolicy` 接口**（0.5 天）—— 还技术债，且是后续一切的基座
2. **L1 移植规则模型**（1 天）—— 最低成本、立即可测、提升兜底质量
3. **L2 接 DouZero**（3-5 天）—— 先只做 3 人标准局，4 人局明确回退
4. **复盘教练**（1-2 天）—— 复用已有 `matchLog` 明细，加 Q 值列

不建议现在做 L3 训练，也不建议把精力花在"给德州接强 AI"上——那是学术未解问题，不是工程问题。
