# AGENTS.md — 交给 AI Agent / 自动化工具的安装与验收说明

本文件给 AI 编码 Agent、CI 或其他自动化工具使用；人类用户请看 [README.md](README.md)（Windows 双击 `一键安装.bat`，macOS 双击 `一键安装.command`）。

## 项目一句话

纯本地运行的「人类 vs 机器人」无限注德州扑克（TypeScript + React + Vite + Vitest）：带规则引擎、四档本地算法 AI、多个可自定义名称/人物设定的大模型玩家、可选「神态语句」与「AI 军师」、自博弈训练、手机端适配与安卓 APK 打包；只使用虚拟筹码，默认不调用任何外部付费 API（大模型只访问用户自己填写的 OpenAI 兼容地址）。

## AI 功能清单（改动 LLM/UI 前必读）

- **大模型玩家**：可同时加入多个（上限 `MAX_LLM_SEATS = 5`，且不超过桌人数 - 1）；每个有名称、人物设定、Base URL、模型、API Key、温度、超时、输出 token 上限。
- **提示词**：精简英文 + 短键 JSON（`{"a","x","w"}`，开启神态时多 `say`）；动作仍由引擎二次校验合法性。
- **神态语句**：全局开关（默认关闭）；开启后模型返回短 `say`，显示在座位气泡、调试面板。
- **AI 军师**：独立模型配置（中文输出），仅用户点击/发送时调用；用 `buildPlayerView()` 的人类视图构造上下文，不得包含对手底牌。
- **玩家名称**：人类名、本地算法机器人名、大模型名均可自定义（`TableConfig.humanName` / `localBotNames` / `llmSeats[].name`）。
- **体验随机 / 风格**：每个机器人座位在 `createTable` 时由 seed 分配 `styleId`（`src/ai/style.ts` 的 6 种风格），AI 决策时叠加在难度 profile 上（偏移有限）；洗牌与决策使用 `xoshiro128**` + 用途派生随机流；本地机器人台词与思考时间抖动也在 `style.ts` / `useAiDriver.ts`。修改相关代码需更新 `style.test.ts` / `randomness.test.ts`，并保持同 seed 可复现。
- **真人化决策**：`src/ai/humanModel.ts` 提供跨手公开统计（VPIP / PFR / 攻击性 / 面对下注弃牌率）、情绪、按难度分级的对手利用与真人式失误、fold-equity 近似 EV 尺度；`stateMachine.ts` 在每手结束累计 `statsRaw` 与 `mood`，`aiPlayer.ts` 接入四档决策，座位 HUD 显示跨手画像，LLM 提示词带 `READS` 画像。这些状态只能由公开动作推导，不得读取隐藏信息；改动需更新 `humanModel.test.ts`。
- **挑战宗师模式（静态分流，不再逐手回退）**：`options.challenge` 下按人数选引擎——单挑翻前用离线 CFR+ 蓝图（只接 BB 防守）+ SB 放宽；单挑河牌 `solveStreetSubgame()`（双边范围、全树遍历全部 combo 同时更新的 vanilla CFR+，含加注）**默认关闭**（`ENABLE_RIVER_SOLVER=true`；配对消融 −4.9~−10.1，CI 含 0）；3 人用旧范围 + 多人谨慎 + 挑战启发式；4–6 人用专家启发式 + 多人谨慎。**禁止**再把挑战动作改回 `expertDecision.action`；`pickChallengeDecision` 已删除。改动需更新 `challenge.test.ts`、`solver.test.ts`、`families.test.ts`。
- **CFR+ / 翻前蓝图 / 河牌 MCCFR / 按街范围**：`src/ai/solver/` 是新的算法层。`cfr.ts` 提供遗憾匹配+、线性平均、矩阵博弈求解；`abstraction.ts` 按**真实胜率**分 10 个桶（不再用 Chen 分数）并提供牌面纹理 / 组合；`preflop.ts` 在 HU 抽象树上跑 CFR+ 并查 `data/preflop-blueprint.json`（24 桶、SB+BB 双边已接入运行时，SB 树禁用跛入）；`buildBlueprintRangeWeights()` 用蓝图动作频率推出翻后范围（策略一致先验）；`subgameTurn.ts` 做**转+河联合求解**（河牌按牌面分 3 桶、桶内矩阵平均；终点是摊牌，无需价值函数），默认启用；`subgame.ts` 对 HU 河牌做**双边范围 vanilla CFR+**（全树遍历、全部 combo 同时更新；check/bet 33/50/100，fold/call/raise；平均策略跳过前 50% 迭代、前 30 轮按 √T/(√T+1) 折减遗憾），默认关闭；`ranges.ts` 做按街贝叶斯范围更新（已实现，但启发式仍用旧 `buildChallengeRanges`，因为新似然参数下基准更差）；`blueprint.ts` 负责加载。离线生成：`npm run gto:equity` / `npm run gto:blueprint`。**约束**：求解器只接收 `PlayerView` + 自己底牌；不得把 `HandState` / `deck` / `burned` / 对手底牌传进去。改动需更新 `solver.test.ts`。
- **翻前决策必须走 EV 引擎（v0.21.0 起）**：`src/ai/preflopEv.ts` 对 fold / check / call / raise 逐个算期望值取最大，
  `decidePreflop` 只负责组装输入（范围估计、加注尺度、噪声）。**禁止**再引入「入池线 / 加注线 / 3-bet 线」这类阈值表——
  它们有三个结构性缺陷：跟注额不参与决策、位置只改阈值不改价值、加注不看弃牌率。
  EV 公式里四项参数（对手范围、权益实现率、弃牌率、被再加注率）都必须有依据，改动要同步 README 的校准表。
  **开池阶段禁止跛入**（除非前面有人跛入或单挑 SB）：纯 EV 上跛入看着便宜，但会招来加注且翻后无位置。
  校准工具：`npm run sweep:preflop`（扫 169 个分类，对照公开 GTO 频率）。改动需更新 `preflopCall.test.ts`。

- **翻前跟注必须看底池赔率（v0.20.0 起，已被 EV 引擎取代）**：`src/ai/preflopCall.ts` 提供「对加注范围胜率 vs 底池赔率」的判定，
  在 `decidePreflop` 里当 `commitFraction >= 0.25` 时接管决策。**禁止**把翻前跟注改回「只看百分位阈值」——
  那会让「面对加注到 40」和「面对 126BB 全下」用同一个跟注范围（真实对局里因此亏掉 5040 的底池）。
  另：`preflopStrength` 必须按**真实胜率**排序（`data/preflop-equity.json`），不能用 Chen 公式——
  Chen 会把 J9o 排在 Q9o 前面，违反压制关系。改动需更新 `preflopCall.test.ts`。

- **剥削层（`src/ai/exploit.ts`）**：把公开统计转成三个决策阈值的调整量——价值线、诈唬率、跟注线。**禁止**再在 `aiPlayer.ts` 里写死这些阈值。设计约束：
  - 以 GTO 基准为原点：诈唬率按 α(bet) = bet/(pot+2bet) 随尺度缩放；跟注线从底池赔率出发；对「从不弃牌」的对手价值线压到 0.5（下注的盈亏平衡点）。
  - 采纳权重 `w = confidence × closeness`：样本不足（`confidence < 0.25`）完全退回基准；低难度（closeness 低）几乎不调整。
  - **跟注线只由攻击信号决定，不要用弃牌率**。初版加过 `+0.06 × foldSignal`，结果对跟注站把跟注线降了下来（他弃牌率低是因为爱跟、不爱下注），方向反了。
  - `hasStrongExploitRead()`：强读（置信度 ≥0.5 且信号极端）时**跳过 CFR 求解器**。求解器假设对手按均衡打，对从不弃牌的对手均衡打法不是最优（实测转牌下注率只有 8%，跳过求解器后升到 54%）。
  - 翻前跛入门槛要按「会不会被再加注」分开：攻击性 ≥2.5 的对手门槛 0.65（加注后被反打要亏 3.2BB），单纯不弃牌的跟注站门槛 0.35（不会被反打）。用同一个门槛会让其中一边明显亏。
  - **统计口径前提**：`allin` 必须按「是否抬高下注额」计入 `raises` / `calls`。旧实现完全不计，导致每手全下的对手 `aggression = 0`（被当成最被动的人），上面所有针对激进对手的逻辑都会失效。
  - 只用公开统计（`OpponentSummary`）与公开动作，不得读对手底牌。
  - 改动需更新 `exploit.test.ts`（14 个零噪声断言 + 接线测试）。

- **单步搜索 / 多人谨慎（保留为启发式层）**：`src/ai/search.ts` 提供单步 EV 搜索与多人谨慎系数；`aiPlayer.ts` 在挑战启发式分支仍会用它，但单挑转/河优先走 `solveStreetSubgame()`。`estimateActionEv` 与搜索都计入 continuation value（口径一致）。改动需更新 `gto.test.ts` 的搜索用例。
- **容错**：思考型模型正文为空（`finish_reason=length`）时用更短提示 + 更大 token 预算重试一次；支持 `reasoning_content` / `thinking`；仍失败则抛可读 LlmError 并回退本地算法。
- 修改 LLM 相关代码后必须更新/补充 `src/tests/llm*.test.ts`、`advisor.test.ts`、`llmSettings.test.ts`。
- **手机 / 安卓壳**：`capacitor.config.json` + `android/` 是 Capacitor 7 安卓工程（`webDir: dist`，appId `com.localholdem.app`）；`scripts/build-apk.mjs` 先在 ASCII 目录完成 Gradle 打包再复制回 `apk/`（本项目路径含中文，AGP 不允许原地构建）。`src/ui/mobile.ts` 负责布局断点、手机默认收起设置栏、横屏判定与 Capacitor 安卓壳检测；安卓壳内「导出历史」改走剪贴板（WebView 不支持 a[download]）。改动需更新 `src/tests/mobile.test.ts`，并保持桌面 1440×900 布局不回归。

## 环境要求

- Node.js **22.12+**（推荐 24 LTS；Vite 8 与 Vitest 5 的 engines 要求），npm 10+。
- 支持 Windows / macOS / Linux；仅安装 npm 依赖、自动安装 Node.js 时需要联网。
- 硬件无特殊要求：双核 + 4 GB 内存即可游玩，**不需要独立显卡**；只有可选的本地大模型机器人需要显存 / 内存（详见 README「推荐硬件配置」）。
- **打包安卓 APK（可选）**：需要 JDK 21+ 与 Android SDK（platform android-35 / build-tools 35）。本机默认路径：JDK `C:\AndroidToolchain\jdk21`、SDK `C:\AndroidToolchain\sdk`、Gradle 缓存 `C:\AndroidToolchain\gradle-home`；可用 `HOLDEM_JDK` / `ANDROID_HOME` / `GRADLE_USER_HOME` / `HOLDEM_APK_BUILD_DIR` 覆盖。只改 Web 代码日常开发不需要这套工具链。
- **Node.js 自动安装行为（重要）**：启动器会先检查本机；已有 Node.js 就直接跳过、绝不重复安装或升级；只有确实没有时才询问并自动安装官方 LTS。
  - Windows：`scripts/install-node.ps1`（下载 nodejs.org 官方 MSI + msiexec，会弹 UAC 管理员授权）。
  - macOS：`scripts/launcher-common.sh`（下载官方 pkg + `sudo installer`，需输入 Mac 登录密码；失败回退 Homebrew）。
  - Linux：发行版差异大，只给手动安装指引，不自动安装。
  - `--install-node`：缺 Node 时免询问直接安装；`--agent` 无人值守模式**默认不自动安装**（缺 Node 时 exit 1 并提示），避免 Agent 擅自修改系统。

## 一键安装（推荐，非交互）

```bash
node scripts/setup.mjs --agent
```

- 依次执行：检查 Node/npm 版本 → `npm install` → `npm test` → `npm run build`。
- 成功标志：**退出码 0**，且输出最后一行 `SETUP_RESULT=OK`；失败退出码 1 并输出 `SETUP_RESULT=FAIL`。
- 首次安装约 10–60 秒（取决于网络与 npm 缓存）。
- 各平台等价入口（都不会暂停、不会打开浏览器）：
  - Windows：`一键安装.bat --agent`
  - macOS / Linux：`bash 一键安装.sh --agent`（macOS 也可双击 `一键安装.command`）
- `--install-node`：本机缺 Node.js 时免询问自动安装（已有 Node 时不做任何安装动作）；无人值守环境需要自动装 Node 时才加，CI 建议预装 Node 后直接用 `--agent`。

其他选项：

```bash
node scripts/setup.mjs --skip-tests     # 安装 + 构建，跳过测试
node scripts/setup.mjs --install-only   # 只安装依赖
node scripts/setup.mjs --check          # 只检查环境（启动器内部使用）
```

## 安装步骤（需要分步控制时）

| 步骤 | 命令 | 预期 |
| --- | --- | --- |
| 安装依赖 | `npm install --no-audit --no-fund` | 生成 `node_modules/`，退出码 0 |
| 类型检查 | `npx tsc --noEmit` | 无输出、退出码 0 |
| 测试 | `npm test` | `30 passed` 测试文件、`385 passed` 用例 |
| 基准 | `npm run bench` | 输出各对手 BB/100 + 95% CI + solver 占比 |
| 剥削审计 | `npm run audit:exploit` | 对 6 种固定对手做配对 A/B（剥削层开/关），输出绝对胜率 + 配对差值 + 95% CI |
| 翻前蓝图 | `npm run gto:blueprint` | 输出可利用度（当前 0.0176 BB/手 @6 万次迭代） |
| 构建 | `npm run build` | 生成 `dist/`，退出码 0 |
| 训练冒烟 | `npm run train -- --rounds=1 --seed=agent-smoke` | 约 2–4 秒，退出码 0 |
| 打包 APK（可选） | `npm run apk` | 输出 `APK_RESULT=OK`，生成 `apk/德州扑克-v<version>.apk`（首次约 2–5 分钟） |
| 打包 Windows 桌面版（可选） | `npm run exe` | 生成 `release/Holdem-Setup-<version>.exe`（约 117 MB）；`release/` 已 gitignore |
| 打包单文件 HTML（跨平台） | `npm run single` | 生成 `release/德州扑克.html`（约 590 KB，零外部依赖，双击即玩）；自检 `npx electron scripts/smoke-single.cjs <html> <out>` 必须输出 `SINGLE_OK` |

## 启动与冒烟检查

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

- 浏览器访问 `http://localhost:5173` 或 `http://127.0.0.1:5173`。
- 无 GUI 环境下可用 HTTP 探测代替浏览器：`curl -sI http://127.0.0.1:5173/` 返回 200（页面为 Vite 注入的 `index.html`）。
- 首次访问会弹出新手教程并停留在「大厅」，**不会自动发牌**；点「开始对局」才开始。若要脚本化验证发牌，可参考 README 中 headless Edge 的做法。
- 关闭服务：Ctrl+C 或结束对应 node 进程；不要把开发服务器留在后台。

## 关键约束（修改代码前必读）

> ### 第 0 条（最高优先级）：每次更新都必须证明「没有变弱」
>
> **任何一次改动，交付前都必须跑一次「对上一个版本」的对照，并给出数字。**
> 不允许用「这次只是加功能 / 只改了架构 / 逻辑上等价」跳过。
>
> 具体要求：
> 1. **对照对象**：上一个已发布的 tag / commit（当前基线 v0.23.0）。把 `scripts/session.ts`
>    复制进老版本源码目录，用**完全相同的参数、相同的 seed、相同的对手**各跑一遍。
> 2. **必须覆盖三档 × 三对手**：专家 / 挑战宗师 × 跟注站 / 弃牌怪 / 全下怪，每项 ≥ 800 手。
> 3. **报数必须带 95% CI**。点估计变好但区间大幅重叠时要如实写「在噪声内」，
>    不能把噪声当结论；点估计变差时**不允许合并**，必须先修或明确回滚该项。
> 4. **结论写进 README 的版本小节和提交信息**，格式：
>    `对手 | 老版本 | 新版本 | 是否回退`。缺失这一节的提交视为未完成。
> 5. 如果某项改动无法证明不弱（例如需要重训模型但样本不够），**默认关闭**该特性，
>    把开关留成 `false`，并在 README 写明「实测为负贡献，默认关闭」。

1. **不引入外部付费 API / LLM API 调用**。大模型玩家与 AI 军师只访问用户自己填写的 OpenAI 兼容地址（默认未启用，失败自动回退本地算法）；不得在代码里内置任何第三方密钥或默认外部地址。
2. **只使用虚拟筹码**，不得加入真钱、充值、提现、广告或联网对战。
3. **UI 使用中文**；保持现有视觉风格（深绿牌桌 + 金色点缀，CSS 在 `src/ui/styles.css`）。
4. **AI 不能作弊**：AI 只能通过 `buildPlayerView()`（`src/game/playerView.ts`）读取自己的底牌与公共信息，禁止把其他玩家底牌传给 AI。
5. **规则正确性优先**：改动引擎逻辑必须附带或更新 `src/tests/` 中的测试，并保证 `npm test` 全绿；注意边池、short all-in、单挑、大盲 option、未跟注退回、奇数筹码等边界。
6. **可复现种子**：引擎随机性由 `seed + handNo` 决定（`src/game/cards.ts`）；UI 默认每局随机种子（`src/ui/seed.ts`）。
7. **体验随机**：风格/随机化只能小幅调整合法动作与参数，不得破坏难度档差异、不得读取隐藏信息；所有新增随机必须走种子派生流。真人化层（跨手统计 / 情绪 / 真人式失误）同样只能基于公开动作与自己的状态，不得利用隐藏信息。
8. 不要改动启动脚本的编码/权限约定：`.bat` 为 **UTF-8 无 BOM + CRLF**；`.sh` / `.command` 为 **LF**，且 `.command` / `.sh` 在 git 索引中需要保留可执行位（`chmod +x` / `git update-index --chmod=+x`）。
9. **版本号（每次提交必做）**：提交前同步递增 `package.json` 与 `package-lock.json` 的 `version`，并让版本号与本次改动在同一个提交里（当前 v0.15.x：修复 / 文档 / 微调递增补丁号，成块功能递增次版本）；提交信息带上版本号。详见 [README.md](README.md)「版本号约定」。
10. **手机 5/6 人桌布局（v0.22.0 起）**：四条不能回退的约束，改动前先用 `npm run shot:mobile` 出图对比：
    ①行牌提示条在手机端必须**随文档流**（不能 `position: fixed` 盖住工具栏与顶部座位）；
    ②中央 `.table-status` 在手机端**隐藏**——它和底部操作区完全重复，且正好压在左右座位上；
    ③牌桌椭圆必须**窄于座位环**，否则座位整块压在绿色桌面上；
    ④公共牌 `clamp(30px, 7.4vw, 40px)`，再大会和左右座位贴在一起。
    验证工具：`npm run shot:mobile -- <png> [人数] [宽] [高]`（Electron 以真机尺寸渲染截图）。

11. **手机适配**：改 UI / CSS 不得破坏手机布局——≤820px 宽必须保持「牌桌 + 操作区一屏」（`.app-shell--ingame`）、设置栏收进抽屉、触摸目标 ≥46px、安全区 `env(safe-area-inset-*)` 与 `viewport-fit=cover`；桌面 1440×900 不得回归。相关判定在 `src/ui/mobile.ts`，手机样式追加在 `src/ui/styles.css` 末尾「手机 / 平板适配」分区，改动需更新 `mobile.test.ts`。
12. **Windows 桌面版（可选，与 APK 独立）**：`electron/main.cjs` 是主进程（本地 HTTP 服务 + BrowserWindow），
    `electron-builder.yml` 是打包配置。**三条不能改的约束**：
    ①页面必须走本地 HTTP，不能改 `file://`（Vite 产物是绝对路径，会白屏）；
    ②`electronDist` 必须指向 `node_modules/electron/dist`，否则打包时会去 GitHub 下载并在需要代理的网络下静默卡死；
    ③`createDesktopShortcut` 必须是 `always`，否则静默安装不建桌面图标。
    改动后跑冒烟：`HOLDEM_SMOKE=1 HOLDEM_SMOKE_OUT=<文件> npx electron .`，必须输出 `SMOKE_OK`。

13. **单文件 HTML（跨平台兜底）**：`vite.config.single.ts` + `scripts/build-single.mjs`。
    它把 JS/CSS 全部内联，并删掉 `manifest` / `apple-touch-icon` 两个外部 `<link>`，
    保证 `file://` 下零请求。**约束**：不要给它加任何需要网络请求的资源（字体、CDN、图片外链），
    否则双击打开就会挂。改动后必须跑 `scripts/smoke-single.cjs` 验证 `SINGLE_OK`。

15. **强度回归必须用「会话台」（v0.23.0 起）**：`scripts/session.ts` 在同一张桌子上连打 N 手，
    对手统计（`statsRaw`）会累积；每手把双方筹码重置到固定 50BB，保证每手是同一个随机变量。
    **不要再用「每手新建桌子」的口径**（旧 `scripts/_cmp.ts` 已删除）：那样 `statsRaw` 永远是空的，
    读人层被完全屏蔽，测出来的分只反映「单手能猜多准」，会把「会不会读人」这项能力整段抹掉
    ——v0.22.0 曾因此误判「专家档对全下怪只有 +63.8」，换口径后其实是 +323.8。
    对比老版本时，把同一份 `session.ts` 放进老版本源码目录，用**完全相同的参数**跑。
    50BB 筹码下每手都是掷硬币式全下，400 手的 95% CI 约 ±250 BB/100，报数必须带 CI。

    三个口径，按用途选：
    - **对固定对手**（`session.ts`）：只看「对极端打法是否更狠」，单臂 CI 约 ±120/800 手。
    - **配对消融**（`session-paired.ts`）：同手同 seed 跑两臂比每手差值，方差缩减 26~28 倍，
      用来测 10~20 BB/100 级的小改动。**测求解器类改动不要用跟注站/弃牌怪**——
      面对纯被动线路时 `strongRead` 会直接跳过求解器，差值恒为 0。
    - **新旧对打**（`head2head.ts` + `git worktree`）：唯一能回答「整体是否变强」的口径。
      2000 手（4000 局）CI 约 ±60。固定对手已接近天花板，整体强度只能这样测。
      用法：`git worktree add ../holdem-old <旧 commit>`，把 `scripts/session.ts` 复制过去，
      然后 `HANDS=1200 npx tsx scripts/head2head.ts`；跑完 `git worktree remove --force ../holdem-old`。

14. **安卓 APK（每次版本更新必做）**：每个版本都要重新执行 `npm run apk` 并更新 `apk/` 目录（只保留当前版本文件），APK 的 versionName 由 `package.json` 自动生成；不要提交签名密钥（默认在 `C:\AndroidToolchain\keystore\`，已在 `android/.gitignore` 忽略）。

## 目录速览

| 路径 | 内容 |
| --- | --- |
| `src/game/` | 纯函数规则引擎（牌堆、牌型、下注、边池、状态机、受限视图、日志） |
| `src/ai/` | 四档难度、范围模型、蒙特卡洛胜率、大模型机器人、训练参数；`data/` 为训练产物 |
| `src/ui/` | React 界面（教程、大厅、牌桌、设置栏、调试面板、历史回放）；`mobile.ts` 为手机布局判定与安卓壳检测 |
| `src/tests/` | Vitest 测试（32 个文件 / 430 个用例） |
| `src/ai/style.ts` | 体验随机：机器人风格原型 / 下注尺度偏好 / 本地台词 / 变化率 |
| `src/ai/humanModel.ts` | 真人化：跨手统计 / 情绪 / 对手利用 / 真人式失误 / fold-equity EV |
| `src/ai/challenge.ts` | 挑战宗师：宗师原型 / 读计时与下注细节 / 计时伪装 / range 极化 / EV 尺度 |
| `src/ai/solver/` | 真 CFR+：`cfr.ts` 原语 / `preflop.ts` 翻前蓝图 / `subgame.ts` 河牌子博弈 / `subgameTurn.ts` 转+河联合 / `ranges.ts` 按街范围 / `abstraction.ts` 真实胜率桶 |
| `src/ai/exploit.ts` | 剥削层：公开统计 → 价值线 / 诈唬率 / 跟注线；强读时跳过均衡求解 |
| `src/ai/preflopCall.ts` | 翻前范围估计 + 对范围胜率的蒙特卡洛 |
| `src/ai/preflopEv.ts` | 翻前 EV 引擎：逐动作算期望值，取代阈值表 |
| `src/ai/gto.ts` | GTO 频率公式 / 短码 push-fold / EV 尺度混合（保留为启发式层） |
| `src/ai/gtoTable.ts` | B1：离线 push/fold 策略表加载 + 筹码深度插值 |
| `src/ai/gtoAdvice.ts` | B1：短码单挑建议（查表优先，表外回退在线求解） |
| `src/ai/search.ts` | 深度受限搜索（单步 EV）+ 多人谨慎系数（DeepStack / Pluribus 启发） |
| `src/ai/llmClient.ts` | OpenAI 兼容 chat 客户端（内容提取、思考内容、错误翻译） |
| `src/ai/llmBot.ts` / `advisor.ts` | 大模型玩家（精简英文提示词、短 JSON、重试、神态）/ AI 军师（中文，按需） |
| `src/ui/LlmSettingsModal.tsx` / `AdvisorPanel.tsx` | AI 玩家/名称/军师设置 / 军师聊天面板 |
| `scripts/setup.mjs` | 一键配置：安装依赖 → 测试 → 构建自检（`--agent` / `--check` / `--skip-tests`） |
| `scripts/sync-data.mjs` | 一键同步旧版本数据（训练参数 / 经验库 / 训练产物 → 当前版本，覆盖前备份到 `backup/`；`--from` / `--dry-run` / `--list`） |
| `scripts/install-node.ps1` / `scripts/launcher-common.sh` | 启动器共用的 Node.js 检测与自动安装（Windows / macOS；Ask/Auto/Check 或 ask/auto/never 模式） |
| `scripts/train.ts` | 自博弈训练（参数进化 + few-shot 经验 + SFT 数据集 + 报告） |
| `android/` | Capacitor 7 安卓工程（应用图标 / 启动图 / 主题 / 清单 / Gradle 配置已定制） |
| `apk/` | 当前版本的安卓安装包（release 签名，交付物） |
| `capacitor.config.json` | 安卓壳配置（appId / 应用名 / webDir=dist / 允许 http 本地模型） |
| `scripts/build-apk.mjs` | 一键打包 APK：Web 构建 → cap sync → ASCII 目录 Gradle → 复制回 `apk/` |
| `training/` | 最近一次训练报告与 SFT 数据集 |
| `docs/` | README 用界面截图 |

## 验收清单（DoD）

- [ ] `node scripts/setup.mjs --agent` 退出码 0，输出 `SETUP_RESULT=OK`
- [ ] `npm test`：32 个测试文件、422 个用例全部通过
- [ ] `npm run build`：生成 `dist/`，无 TypeScript 错误
- [ ] `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` 可启动，HTTP 探测 200
- [ ] 启动脚本冒烟（按平台）：Windows `启动德州扑克.bat --no-open` / macOS-Linux `bash 启动德州扑克.sh --no-open` 能起服务并返回 200
- [ ] Node.js 检测语义：已有 Node 时启动器直接跳过安装；缺 Node + `--agent` 时 exit 1 且不安装（需要自动装时用 `--install-node`）
- [ ] `package.json` 版本号已按约定递增（当前 v0.15.x），并与本次改动在同一个提交
- [ ] `npm run apk` 退出码 0 且输出 `APK_RESULT=OK`；`apk/` 内只有与 `package.json` 版本一致的 APK
- [ ] （若本次改了前端）`npm run exe` 退出码 0；`release/Holdem-Setup-<version>.exe` 存在；用冒烟模式跑打包后的 `release/win-unpacked/德州扑克.exe` 输出 `SMOKE_OK`
- [ ] APK 冒烟：`aapt2 dump badging` 的 versionName 与 `package.json` 一致、label 为「德州扑克」；`apksigner verify` 通过（release 签名）
- [ ] 手机布局冒烟：390×844 / 360×640 / 844×390 下进行中牌桌与操作区一屏（无纵向滚动 / 横向溢出），桌面 1440×900 正常
- [ ] 一键同步数据冒烟：`node scripts/sync-data.mjs --help` 退出码 0；`--list` 能识别同级旧版本目录
- [ ] 挑战宗师冒烟：`npm test` 中 `challenge.test.ts` + `solver.test.ts` + `families.test.ts` 全绿；`npm run bench` 能输出配对 95% CI；当前挑战 vs 专家为 -9.6（CI 含 0），**不得在文档/提交信息里宣称“已证明更强”**；难度选择「挑战宗师」后座位显示徽标、调试面板出现 `CFR+ 蓝图` / `challenge-multiway`（河牌 MCCFR 默认关闭），无 console 报错
- [ ] 工作区没有 `node_modules/`、`dist/`、日志或临时脚本被误加入提交（`.gitignore` 已覆盖）

## 常见问题

| 现象 | 处理 |
| --- | --- |
| Node 版本过低 / `engine` 报错 | 安装 Node.js 22.12+（推荐 24 LTS）；不要用 Node 20 或 23/25 |
| `npm install` 很慢或失败 | `npm config set registry https://registry.npmmirror.com` 后重试 |
| 端口 5173 被占用 | Windows：`netstat -ano | findstr :5173`；macOS/Linux：`lsof -i :5173`；或换端口 `--port 5174` |
| PowerShell 拒绝执行脚本 | 用 `.bat` 入口，或 `powershell -ExecutionPolicy Bypass -File ...`；Node 脚本不受影响 |
| macOS 双击 `.command` 提示无法验证开发者 | 右键 → 打开；或 `xattr -dr com.apple.quarantine .`（仅下载 zip 后需要，git clone 不会） |
| macOS/Linux 下 `$'\r': command not found` | 文件被转成了 CRLF；用 `sed -i 's/\r$//' 文件名` 或重新 `git checkout` |
| 无浏览器 / 无 GUI 环境 | 跑 `npm test` + `npm run build` 即可验收；不需要真实浏览器 |
| 本地大模型探测不到 | 那是可选项；确认本机服务已开 CORS（如 `OLLAMA_ORIGINS=*`）再试，不影响游戏 |
| 大模型“返回空内容” | 多为思考型模型把 token 用尽：已自动重试一次并支持 `reasoning_content`；仍失败请换非思考模型或调大该座位的「输出 token 上限」 |
| 自动安装 Node.js 失败 | 需要联网和管理员权限（Windows UAC / macOS 登录密码）；公司电脑或标准用户可能被策略拦截，脚本会回退为手动安装指引，安装后重新运行启动器即可 |
| `npm run apk` 报 `invalid source release: 21` | 用了 JDK 17 编译 Capacitor 7 安卓库：把 `HOLDEM_JDK` / `JAVA_HOME` 指向 JDK 21（本机默认 `C:\AndroidToolchain\jdk21`） |
| Gradle 报「项目路径包含非 ASCII 字符」 | AGP 不允许在 `D:\德州扑克\android` 直接构建；`npm run apk` 已自动复制到 ASCII 构建目录，不要在原目录手动跑 gradlew |
| 手机安装 APK 被拦截 / 覆盖安装失败 | 首次安装需在系统设置里允许「安装未知应用」；覆盖安装要求同一签名，本机固定密钥在 `C:\AndroidToolchain\keystore\`，换电脑需先卸载旧版再装 |

## 禁止事项

- 不要提交 `node_modules/`、`dist/`、`coverage/`、`*.log`、临时验证脚本、`android/app/build/`、`android/.gradle/`、签名密钥与 `keystore.properties`。
- 不要删除 `apk/` 里当前版本的安装包（它是交付物）；也不要提交旧版本 APK。
- 不要在代码、测试或文档里写入真实 API Key、Token、个人路径。
- 不要为「通过验收」而跳过测试或伪造训练报告；改动后必须真实运行验证命令。
- 不要在无人值守环境绕过 `--agent` 的“不自动安装 Node.js”语义去安装系统软件；确有必要时显式使用 `--install-node`，并先确认有管理员权限。
