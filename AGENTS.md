# AGENTS.md — 交给 AI Agent / 自动化工具的安装与验收说明

本文件给 AI 编码 Agent、CI 或其他自动化工具使用；人类用户请看 [README.md](README.md)（Windows 双击 `一键安装.bat`，macOS 双击 `一键安装.command`）。

## 项目一句话

纯本地运行的「人类 vs 机器人」无限注德州扑克（TypeScript + React + Vite + Vitest）：带规则引擎、四档本地算法 AI、多个可自定义名称/人物设定的大模型玩家、可选「神态语句」与「AI 军师」、自博弈训练；只使用虚拟筹码，默认不调用任何外部付费 API（大模型只访问用户自己填写的 OpenAI 兼容地址）。

## AI 功能清单（改动 LLM/UI 前必读）

- **大模型玩家**：可同时加入多个（上限 `MAX_LLM_SEATS = 5`，且不超过桌人数 - 1）；每个有名称、人物设定、Base URL、模型、API Key、温度、超时、输出 token 上限。
- **提示词**：精简英文 + 短键 JSON（`{"a","x","w"}`，开启神态时多 `say`）；动作仍由引擎二次校验合法性。
- **神态语句**：全局开关（默认关闭）；开启后模型返回短 `say`，显示在座位气泡、调试面板。
- **AI 军师**：独立模型配置（中文输出），仅用户点击/发送时调用；用 `buildPlayerView()` 的人类视图构造上下文，不得包含对手底牌。
- **玩家名称**：人类名、本地算法机器人名、大模型名均可自定义（`TableConfig.humanName` / `localBotNames` / `llmSeats[].name`）。
- **体验随机 / 风格**：每个机器人座位在 `createTable` 时由 seed 分配 `styleId`（`src/ai/style.ts` 的 6 种风格），AI 决策时叠加在难度 profile 上（偏移有限）；洗牌与决策使用 `xoshiro128**` + 用途派生随机流；本地机器人台词与思考时间抖动也在 `style.ts` / `useAiDriver.ts`。修改相关代码需更新 `style.test.ts` / `randomness.test.ts`，并保持同 seed 可复现。
- **真人化决策**：`src/ai/humanModel.ts` 提供跨手公开统计（VPIP / PFR / 攻击性 / 面对下注弃牌率）、情绪、按难度分级的对手利用与真人式失误、fold-equity 近似 EV 尺度；`stateMachine.ts` 在每手结束累计 `statsRaw` 与 `mood`，`aiPlayer.ts` 接入四档决策，座位 HUD 显示跨手画像，LLM 提示词带 `READS` 画像。这些状态只能由公开动作推导，不得读取隐藏信息；改动需更新 `humanModel.test.ts`。
- **容错**：思考型模型正文为空（`finish_reason=length`）时用更短提示 + 更大 token 预算重试一次；支持 `reasoning_content` / `thinking`；仍失败则抛可读 LlmError 并回退本地算法。
- 修改 LLM 相关代码后必须更新/补充 `src/tests/llm*.test.ts`、`advisor.test.ts`、`llmSettings.test.ts`。

## 环境要求

- Node.js **22.12+**（推荐 24 LTS；Vite 8 与 Vitest 5 的 engines 要求），npm 10+。
- 支持 Windows / macOS / Linux；仅安装 npm 依赖、自动安装 Node.js 时需要联网。
- 硬件无特殊要求：双核 + 4 GB 内存即可游玩，**不需要独立显卡**；只有可选的本地大模型机器人需要显存 / 内存（详见 README「推荐硬件配置」）。
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
| 测试 | `npm test` | `22 passed` 测试文件、`292 passed` 用例 |
| 构建 | `npm run build` | 生成 `dist/`，退出码 0 |
| 训练冒烟 | `npm run train -- --rounds=1 --seed=agent-smoke` | 约 2–4 秒，退出码 0 |

## 启动与冒烟检查

```bash
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

- 浏览器访问 `http://localhost:5173` 或 `http://127.0.0.1:5173`。
- 无 GUI 环境下可用 HTTP 探测代替浏览器：`curl -sI http://127.0.0.1:5173/` 返回 200（页面为 Vite 注入的 `index.html`）。
- 首次访问会弹出新手教程并停留在「大厅」，**不会自动发牌**；点「开始对局」才开始。若要脚本化验证发牌，可参考 README 中 headless Edge 的做法。
- 关闭服务：Ctrl+C 或结束对应 node 进程；不要把开发服务器留在后台。

## 关键约束（修改代码前必读）

1. **不引入外部付费 API / LLM API 调用**。大模型玩家与 AI 军师只访问用户自己填写的 OpenAI 兼容地址（默认未启用，失败自动回退本地算法）；不得在代码里内置任何第三方密钥或默认外部地址。
2. **只使用虚拟筹码**，不得加入真钱、充值、提现、广告或联网对战。
3. **UI 使用中文**；保持现有视觉风格（深绿牌桌 + 金色点缀，CSS 在 `src/ui/styles.css`）。
4. **AI 不能作弊**：AI 只能通过 `buildPlayerView()`（`src/game/playerView.ts`）读取自己的底牌与公共信息，禁止把其他玩家底牌传给 AI。
5. **规则正确性优先**：改动引擎逻辑必须附带或更新 `src/tests/` 中的测试，并保证 `npm test` 全绿；注意边池、short all-in、单挑、大盲 option、未跟注退回、奇数筹码等边界。
6. **可复现种子**：引擎随机性由 `seed + handNo` 决定（`src/game/cards.ts`）；UI 默认每局随机种子（`src/ui/seed.ts`）。
7. **体验随机**：风格/随机化只能小幅调整合法动作与参数，不得破坏难度档差异、不得读取隐藏信息；所有新增随机必须走种子派生流。真人化层（跨手统计 / 情绪 / 真人式失误）同样只能基于公开动作与自己的状态，不得利用隐藏信息。
8. 不要改动启动脚本的编码/权限约定：`.bat` 为 **UTF-8 无 BOM + CRLF**；`.sh` / `.command` 为 **LF**，且 `.command` / `.sh` 在 git 索引中需要保留可执行位（`chmod +x` / `git update-index --chmod=+x`）。
9. **版本号（每次提交必做）**：提交前同步递增 `package.json` 与 `package-lock.json` 的 `version`，并让版本号与本次改动在同一个提交里（当前 v0.3.x：修复 / 文档 / 微调递增补丁号，成块功能递增次版本）；提交信息带上版本号。详见 [README.md](README.md)「版本号约定」。

## 目录速览

| 路径 | 内容 |
| --- | --- |
| `src/game/` | 纯函数规则引擎（牌堆、牌型、下注、边池、状态机、受限视图、日志） |
| `src/ai/` | 四档难度、范围模型、蒙特卡洛胜率、大模型机器人、训练参数；`data/` 为训练产物 |
| `src/ui/` | React 界面（教程、大厅、牌桌、设置栏、调试面板、历史回放） |
| `src/tests/` | Vitest 测试（22 个文件 / 292 个用例） |
| `src/ai/style.ts` | 体验随机：机器人风格原型 / 下注尺度偏好 / 本地台词 / 变化率 |
| `src/ai/humanModel.ts` | 真人化：跨手统计 / 情绪 / 对手利用 / 真人式失误 / fold-equity EV |
| `src/ai/llmClient.ts` | OpenAI 兼容 chat 客户端（内容提取、思考内容、错误翻译） |
| `src/ai/llmBot.ts` / `advisor.ts` | 大模型玩家（精简英文提示词、短 JSON、重试、神态）/ AI 军师（中文，按需） |
| `src/ui/LlmSettingsModal.tsx` / `AdvisorPanel.tsx` | AI 玩家/名称/军师设置 / 军师聊天面板 |
| `scripts/setup.mjs` | 一键配置：安装依赖 → 测试 → 构建自检（`--agent` / `--check` / `--skip-tests`） |
| `scripts/install-node.ps1` / `scripts/launcher-common.sh` | 启动器共用的 Node.js 检测与自动安装（Windows / macOS；Ask/Auto/Check 或 ask/auto/never 模式） |
| `scripts/train.ts` | 自博弈训练（参数进化 + few-shot 经验 + SFT 数据集 + 报告） |
| `training/` | 最近一次训练报告与 SFT 数据集 |
| `docs/` | README 用界面截图 |

## 验收清单（DoD）

- [ ] `node scripts/setup.mjs --agent` 退出码 0，输出 `SETUP_RESULT=OK`
- [ ] `npm test`：22 个测试文件、292 个用例全部通过
- [ ] `npm run build`：生成 `dist/`，无 TypeScript 错误
- [ ] `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` 可启动，HTTP 探测 200
- [ ] 启动脚本冒烟（按平台）：Windows `启动德州扑克.bat --no-open` / macOS-Linux `bash 启动德州扑克.sh --no-open` 能起服务并返回 200
- [ ] Node.js 检测语义：已有 Node 时启动器直接跳过安装；缺 Node + `--agent` 时 exit 1 且不安装（需要自动装时用 `--install-node`）
- [ ] `package.json` 版本号已按约定递增（当前 v0.3.x），并与本次改动在同一个提交
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

## 禁止事项

- 不要提交 `node_modules/`、`dist/`、`coverage/`、`*.log`、临时验证脚本。
- 不要在代码、测试或文档里写入真实 API Key、Token、个人路径。
- 不要为「通过验收」而跳过测试或伪造训练报告；改动后必须真实运行验证命令。
- 不要在无人值守环境绕过 `--agent` 的“不自动安装 Node.js”语义去安装系统软件；确有必要时显式使用 `--install-node`，并先确认有管理员权限。
