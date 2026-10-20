<div align="center">

# AIPoker · 扑克 AI 竞技场

**简体中文** | [English](README-en.md)

*与各大模型 / Agent 机器人同台竞技的扑克桌面软件*

![AIPoker 德州扑克牌桌](docs/screenshot-holdem.jpg)

</div>

---

## 简介

**AIPoker** 是一款让你和「大模型 Agent 机器人」坐在一张牌桌上打扑克的桌面应用。游戏引擎用纯 TypeScript 重写，可在浏览器中独立运行；Tauri 仅作为窗口外壳，方便打包成桌面程序。

## ✨ 功能特性

- **双玩法**：斗地主（3~4 人，含叫地主 / 完整牌型识别 / 规则 AI）、德州扑克（最多 9 人，盲注 / 下注 / 加注 / 全下 / 摊牌 / 边池分摊）。
- **Agent 广场**：内置 8 个性格、策略各异的 AI 对手，可一键「设置默认」（开局优先登场，无默认则随机）；也支持你**自定义大模型**（baseUrl / apiKey / model / 头像）。
- **围坐牌桌**：你和所有 Agent 都「坐」在牌桌四周，每个 Agent 头上有「对面 / 左 / 右」方位标签，一眼分清谁是谁；出牌后显示在各 Agent 面前，下次出牌自动覆盖。
- **大模型对战**：通过 OpenAI 兼容接口接入 deepseek / openai / ollama 等，失败自动回退到规则 AI。
- **沉浸体验**：程序化音效（Web Audio，无需音频文件）、翻牌 / 发牌 / 出牌 / 筹码飞行 / 胜利撒花等动画。
- **多语言**：界面支持 简体中文 / 繁體中文 / English / Português / Tiếng Việt。
- **战绩与设置**：本地战绩统计、LLM 参数与个人模型配置。

## 🛠 技术栈

Tauri 2 · Vue 3 · TypeScript · Vite · TailwindCSS · Rust（Tauri 后端）

## 🚀 快速开始

```bash
npm install          # 安装依赖
npm run dev          # 启动 Vite 开发服务器（端口 1420）
npm run build        # 类型检查 + 生产构建（输出 dist/）
```

如需打包为桌面程序（需要 Rust 工具链）：

```bash
npm run tauri dev    # 桌面开发模式
npm run tauri build  # 打包桌面安装包
```

## 📁 项目结构

```
src/
  engine/          # 纯 TS 游戏引擎：cards / doudizhu / holdem / llm
  components/       # 复用组件：Card、HandCards、HoldemSeat、DoudizhuSeat 等
  views/            # 视图：Home / Doudizhu / Holdem / AgentPlaza / Stats / Settings
  store.ts          # 全局状态：视图路由、LLM 设置、Agent 档案、默认/自定义 Agent
  audio/sfx.ts      # 程序化音效
  style.css         # 动画与主题
src-tauri/          # Tauri 窗口外壳（Rust）
scripts/            # 引擎自测脚本
```

## 🤖 自定义对手（接入你的大模型）

进入「Agent 广场」→ 点击「新增」，填写：

- `baseUrl`：OpenAI 兼容接口地址（如 `https://api.deepseek.com/v1`）
- `apiKey`：你的 API Key
- `model`：模型名（如 `deepseek-flash`）
- 头像 / 名称 / 性格设定（persona）

保存后即可在对局中选择该 Agent 作为对手。每个 Agent 可使用独立的大模型配置，互不干扰。

---

© 2026 AIPoker
