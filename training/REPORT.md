# 自博弈训练报告

- 生成时间：2026-11-05T13:53:06.707Z
- 运行模式：默认全量模式
- 运行参数：seed = `demo-b`，hands = 60，rounds = 10，mutations = 3，exhibition = 120，mcIterations = 120
- 并行评估：16 个 worker / 16 核（4 档同时进化，基准与候选并行评估）
- 本次耗时：1.5 秒
- 训练对局总手数：13920 手（含基准评估、候选评估与最终对照评估）
- 经验库展示手数：120 手
- 训练对象：① 规则引擎机器人（四档参数进化）② 大模型机器人（few-shot 经验库 + SFT 数据集）

## 1. 评估方法

- 4 人桌，盲注 10/20，起始筹码 1000；全部为本地 AI，无人类、无大模型、无网络。
- 并行加速：多核机器上 4 档难度同时进化，每轮的基准 + 变异候选、验证对与最终对照都并发提交；每个评估仍有独立固定 seed，并行与单线程结果一致。
- 每手通过 `createHand({ seed: `${seed}-h${handNo}` })` 发牌；按钮每手顺时针轮转。
- hero 座位每手轮转，最终收益按 `netChips / bigBlind / hands * 100` 换算为 BB/100，以平均位置影响。
- 每轮先评估当前基准，再评估 N 个变异候选；候选与基准使用完全相同的 seed 序列（配对评估）。
- 评估口径：hero 使用被评估参数，其余三个座位使用该档当前的基准参数；最终 baseline 固定使用内置基础档位，便于观察累计训练收益。
- 方差控制：每轮基准 / 候选评估使用 `hands` 手；最终 baseline/trained 对照评估使用 4×hands 手（快速 100 手、默认 240 手），并共用同一 seed 序列。
- 接受条件：最优候选的提升 > 0.5 BB/100。
- 交叉验证：拟合集提升的候选还会在独立验证 seed 上复评；验证集回落则放弃，降低小样本过拟合。
- 四档边界：beginner 的 play 限制在 [0.05, 0.30]，normal/hard/expert 各有独立的 play/bluff/semiBluff 边界；play 单步 ±0.04~0.08，raise / threeBet 保持层级约束。
- 翻牌前阈值：`decide` 通过 `preflopThresholdsForProfile(profile, position)` 读取传入的 profileOverride，因此 normal/hard/expert 的 `play` / `raise` / `threeBet` 变异会真实影响决策；beginner 分支仍主要使用 `preflop.play`。
- 异常防御：AI 决策抛错或动作被引擎拒绝时，回退到 `getLegalActions` 的 check/call/fold；每手最多 500 个动作。
- re-buy：任意玩家筹码低于大盲（20）时，下一手开始前统一重置为 1000，保证对局继续；hero 的净收益不计入 re-buy 注入的筹码。
- MC 迭代：训练时统一使用 `maxIterations` 上限（本次 120），beginner/normal 本身不使用蒙特卡洛。

## 2. 规则引擎机器人训练（四档参数进化）

| 难度 | baseline BB/100 | trained BB/100 | Δ BB/100 | 接受变异数 | 实际改动字段列表 |
| --- | ---: | ---: | ---: | ---: | --- |
| 入门（beginner） | 2.38 | 5.13 | +2.75 | 0 | 无字段变化 |
| 普通（normal） | 480.21 | 1215.65 | +735.44 | 3 | preflop.play 0.640→0.587、preflop.raise 0.810→0.852、preflop.bluffRaiseRate 0.088→0.125、preflop.mixRaiseRate 0.058→0.107、postflop.bluffRate 0.179→0.160 |
| 困难（hard） | -997.67 | 397.04 | +1394.71 | 0 | 无字段变化 |
| 专家（expert） | -1169.08 | -853.31 | +315.77 | 0 | 无字段变化 |

- 本次训练有 1/4 档参数发生变化，共接受 3 个变异。
- 训练参数已写入 `src/ai/data/learnedProfiles.json`（每档只写入 10 个可变异字段，其余字段继续使用内置基础档位）。
- 生效方式：在页面设置中打开「使用训练后参数」开关后生效（对应 `setLearnedProfilesEnabled(true)`）；默认关闭时普通对局仍使用内置基础档位。

> 提示：BB/100 的单位是“每 100 手净赢的大盲数”。每轮评估仅 25-60 手，最终对照为 100-240 手，方差仍然较大，表中数值应结合训练报告中的接受过程一起看。
> 最终 baseline/trained 使用独立 seed 的配对评估；若某个被接受的变异在这批对照牌局中没有触发（例如翻牌前混合频率未遇到对应强度区间），两列可能完全相同。
> 被接受的变异不保证在最终对照中仍然提升；在当前样本量下，单轮提升可能来自噪声或对特定对手的过拟合，重复训练 / 换 seed 再观察更可靠。

## 3. 参数进化过程（精简）

> 为避免长轮数报告膨胀，逐轮候选 Δ / seed / 验证明细不再写入，只保留每档接受统计；完整明细以控制台日志为准。

### 入门（beginner）

- 接受 0/10 轮（0.0%）；验证集拦截 4 次；未达阈值 6 轮；训练对局 3360 手。
- 接受时拟合 Δ：无。
- 接受轮次：无。

### 普通（normal）

- 接受 3/10 轮（30.0%）；验证集拦截 2 次；未达阈值 5 轮；训练对局 3480 手。
- 接受时拟合 Δ：最小 +2.50 / 平均 +175.33 / 最大 +458.58 BB/100。
- 接受轮次：第 2 轮 #1、第 4 轮 #1、第 10 轮 #2。

### 困难（hard）

- 接受 0/10 轮（0.0%）；验证集拦截 5 次；未达阈值 5 轮；训练对局 3480 手。
- 接受时拟合 Δ：无。
- 接受轮次：无。

### 专家（expert）

- 接受 0/10 轮（0.0%）；验证集拦截 6 次；未达阈值 4 轮；训练对局 3600 手。
- 接受时拟合 Δ：无。
- 接受轮次：无。

## 4. 最终关键参数

| 参数 | 入门 | 普通 | 困难 | 专家 |
| --- | ---: | ---: | ---: | ---: |
| `preflop.play` | 0.300 | 0.587 | 0.715 | 0.780 |
| `preflop.raise` | 0.866 | 0.852 | 0.768 | 0.911 |
| `preflop.threeBet` | 0.967 | 0.975 | 0.928 | 0.946 |
| `preflop.bluffRaiseRate` | 0.066 | 0.125 | 0.120 | 0.245 |
| `preflop.mixRaiseRate` | 0.459 | 0.107 | 0.224 | 0.297 |
| `preflop.trapRate` | 0.227 | 0.128 | 0.190 | 0.198 |
| `postflop.bluffRate` | 0.010 | 0.160 | 0.256 | 0.214 |
| `postflop.semiBluffRate` | 0.000 | 0.239 | 0.435 | 0.623 |
| `postflop.valueThreshold` | 0.547 | 0.578 | 0.698 | 0.597 |
| `postflop.callMargin` | 0.000 | 0.114 | 0.120 | 0.120 |

> `mcIterations`、`betSizes`、`raiseSizes`、`errorRate`、`positionAware`、`style`、`label` 不在变异范围内，四档保持基础档位设定。

## 5. 大模型机器人训练数据

- few-shot 经验条数：154 条（上限 160）
- SFT 数据集行数：94 行（上限 400）
- 经验库按街道：preflop 120、flop 23、turn 8、river 3
- 经验库按动作：fold 86、check 21、call 8、bet 8、raise 26、allin 5
- SFT 按街道：preflop 60、flop 23、turn 8、river 3
- SFT 按动作：fold 45、check 21、call 3、bet 8、raise 12、allin 5
- 文件路径：`src/ai/data/llm-experience.json`（few-shot 经验库）、`training/llm-sft-dataset.jsonl`（SFT 数据集）。
- 来源：训练后 hard / expert 座位的 exhibition 自博弈；每手最多 1-2 条，只保留合法、未走回退逻辑、动作明确的决策。
- 体积控制：SFT 最多 400 行，其中翻牌前最多 60 条；few-shot 经验最多 160 条；报告只保留汇总统计，不再逐轮展开。
- few-shot 经验库：`LlmExperienceFile`（`generatedAt` / `hands` / `examples`）接口保持不变；本地大模型机器人会在提示词中把匹配街道 / 是否面对下注的样本作为 few-shot 参考。
- SFT 数据集：JSONL，每行一条 `{"messages":[{"role":"system",...},{"role":"user",...},{"role":"assistant",...}]}`；user 消息含街道、位置、底牌、公共牌、底池、当前下注、需跟注、是否面对下注与【合法动作】；assistant 只含 `{"action":...,"amount":...,"reason":...}`。
- 用途：应用内大模型机器人会直接使用 `llm-experience.json` 做 few-shot；`llm-sft-dataset.jsonl` 可交给本地微调工具（llama.cpp / LlamaFactory 等）做可选微调，本项目不自动微调。

## 6. 如何启用训练参数

- 训练产物：`src/ai/data/learnedProfiles.json`（规则引擎四档参数）、`src/ai/data/llm-experience.json`（大模型 few-shot 经验）、`training/llm-sft-dataset.jsonl`（SFT 数据集，应用不会自动加载）。
- 训练参数默认**不启用**：`getDifficultyProfile(difficulty)` 只在 `setLearnedProfilesEnabled(true)` 后合并 `src/ai/data/learnedProfiles.json`。
- 启用方式：UI 设置项「使用训练后参数」对应 localStorage key `holdem-learned-profiles-v1`（`src/ui/storage.ts` 的 `loadLearnedProfilesEnabled` / `saveLearnedProfilesEnabled`），最终通过 `setLearnedProfilesEnabled(true)` 让 `getDifficultyProfile` 合并训练参数；若当前设置栏未显示该开关，可在应用入口显式调用 `setLearnedProfilesEnabled(true)`。
- 训练脚本本身不依赖该全局开关：每次决策都通过 `profileOverride` 显式传入参数，因此训练 / 评估结果不受 UI 开关影响。
- 重新训练：`npm run train:quick`（快速）或 `npm run train`（全量）；Windows 可双击 `训练机器人.bat`。
- 训练完成后需要刷新页面 / 重建前端（`npm run build`）才能让最新的 JSON 进入打包产物。

## 7. 注意事项与已知限制

- 样本量有限：快速模式每轮每档只评估 25 手、最终对照 100 手；默认模式每轮 60 手、最终对照 240 手。BB/100 的置信区间较宽，0.5 BB/100 的接受阈值仍可能放进噪声。
- 参数可能过拟合：同一 seed 的配对评估只能降低牌局噪声，不能消除策略对特定对手（同档基础参数）的过拟合。
- 可重复训练：`learnedProfiles.json` 已存在时，下一次训练会从该文件继续；建议先用 `--seed=...` 换种子多次训练，再观察参数是否稳定。
- 四档风格：入门档的入池线、诈唬频率、半诈唬频率都设了比高难度更窄 / 更保守的边界，避免训练把 beginner 变紧、expert 变松。
- 入门档边界：beginner 的 `preflop.play` 限制在 [0.05, 0.30]，避免训练把入门 AI 变紧；由于 beginner 决策分支只实际读取 `preflop.play` 与不可变异的 `errorRate`，入门档其余可变异字段（加注/诈唬/翻牌后阈值）通常没有行为差异，因此入门档的有效训练维度主要是 play。
- 训练全程本地完成：不联网、不调用大模型、不调用任何付费服务；LLM 经验库与 SFT 数据集都只是静态文件，供本地模型做 few-shot / 可选微调。
- SFT 数据集受 exhibition 手数限制：默认 120 手最多约 240 条有效样本，SFT 上限为 400 行；需要更多数据时可提高 `--exhibition` 手数。
- 本报告每次训练自动覆盖；训练数据写入 `src/ai/data/` 与 `training/`，其中 `src/ai/data/` 下的 JSON 会被 Vite 打包进前端。
