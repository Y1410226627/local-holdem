# 自博弈训练报告

- 生成时间：2026-11-04T16:40:25.692Z
- 运行模式：默认全量模式
- 运行参数：seed = `local-selfplay-v1`，hands = 60，rounds = 10000，mutations = 3，exhibition = 120，mcIterations = 120
- 并行评估：16 个 worker / 16 核（4 档同时进化，基准与候选并行评估）
- 本次耗时：1240.4 秒
- 训练对局总手数：11976480 手（含基准评估、候选评估与最终对照评估）
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
| 入门（beginner） | 15.17 | 15.79 | +0.63 | 845 | preflop.play 0.120→0.300、preflop.raise 0.950→0.866、preflop.threeBet 0.990→0.967、preflop.bluffRaiseRate 0.005→0.066、preflop.mixRaiseRate 0.000→0.459、preflop.trapRate 0.000→0.227、postflop.bluffRate 0.005→0.010、postflop.valueThreshold 0.860→0.547、postflop.callMargin 0.120→0.000 |
| 普通（normal） | 748.88 | 940.54 | +191.67 | 2253 | preflop.play 0.420→0.640、preflop.raise 0.675→0.810、preflop.threeBet 0.900→0.975、preflop.bluffRaiseRate 0.093→0.088、preflop.mixRaiseRate 0.100→0.028、preflop.trapRate 0.040→0.128、postflop.bluffRate 0.070→0.156、postflop.semiBluffRate 0.120→0.239、postflop.valueThreshold 0.720→0.578、postflop.callMargin 0.020→0.114 |
| 困难（hard） | -846.23 | -525.69 | +320.54 | 2209 | preflop.play 0.465→0.715、preflop.raise 0.714→0.768、preflop.threeBet 0.870→0.928、preflop.bluffRaiseRate 0.090→0.120、preflop.mixRaiseRate 0.180→0.224、preflop.trapRate 0.085→0.190、postflop.bluffRate 0.120→0.256、postflop.semiBluffRate 0.343→0.435、postflop.valueThreshold 0.640→0.698、postflop.callMargin 0.053→0.120 |
| 专家（expert） | -1129.33 | 187.73 | +1317.06 | 2342 | preflop.play 0.521→0.780、preflop.raise 0.660→0.911、preflop.threeBet 0.810→0.931、preflop.bluffRaiseRate 0.156→0.245、preflop.mixRaiseRate 0.300→0.329、preflop.trapRate 0.136→0.198、postflop.bluffRate 0.187→0.214、postflop.semiBluffRate 0.380→0.623、postflop.valueThreshold 0.631→0.620、postflop.callMargin 0.050→0.120 |

- 本次训练有 4/4 档参数发生变化，共接受 7649 个变异。
- 训练参数已写入 `src/ai/data/learnedProfiles.json`（每档只写入 10 个可变异字段，其余字段继续使用内置基础档位）。
- 生效方式：在页面设置中打开「使用训练后参数」开关后生效（对应 `setLearnedProfilesEnabled(true)`）；默认关闭时普通对局仍使用内置基础档位。

> 提示：BB/100 的单位是“每 100 手净赢的大盲数”。每轮评估仅 25-60 手，最终对照为 100-240 手，方差仍然较大，表中数值应结合训练报告中的接受过程一起看。
> 最终 baseline/trained 使用独立 seed 的配对评估；若某个被接受的变异在这批对照牌局中没有触发（例如翻牌前混合频率未遇到对应强度区间），两列可能完全相同。
> 被接受的变异不保证在最终对照中仍然提升；在当前样本量下，单轮提升可能来自噪声或对特定对手的过拟合，重复训练 / 换 seed 再观察更可靠。

## 3. 参数进化过程（精简）

> 为避免长轮数报告膨胀，逐轮候选 Δ / seed / 验证明细不再写入，只保留每档接受统计；完整明细以控制台日志为准。

### 入门（beginner）

- 接受 845/10000 轮（8.5%）；验证集拦截 1172 次；未达阈值 7983 轮；训练对局 2642520 手。
- 接受时拟合 Δ：最小 +0.50 / 平均 +4.64 / 最大 +36.58 BB/100。
- 接受轮次：第 1 轮 #1、第 10 轮 #1、第 34 轮 #1、第 35 轮 #1、第 37 轮 #3、第 43 轮 #2、第 62 轮 #1、第 69 轮 #1、第 72 轮 #2、第 95 轮 #2、第 115 轮 #1、第 142 轮 #1、第 155 轮 #2、第 207 轮 #3、第 210 轮 #3、第 231 轮 #3、第 239 轮 #1、第 252 轮 #3、第 254 轮 #2、第 263 轮 #3 等 845 次。

### 普通（normal）

- 接受 2253/10000 轮（22.5%）；验证集拦截 3633 次；未达阈值 4114 轮；训练对局 3106800 手。
- 接受时拟合 Δ：最小 +0.50 / 平均 +164.34 / 最大 +3315.67 BB/100。
- 接受轮次：第 13 轮 #1、第 19 轮 #3、第 30 轮 #2、第 34 轮 #2、第 38 轮 #2、第 41 轮 #3、第 53 轮 #2、第 63 轮 #3、第 70 轮 #2、第 82 轮 #3、第 89 轮 #2、第 90 轮 #2、第 91 轮 #3、第 95 轮 #3、第 99 轮 #1、第 101 轮 #3、第 102 轮 #2、第 103 轮 #1、第 105 轮 #1、第 106 轮 #2 等 2253 次。

### 困难（hard）

- 接受 2209/10000 轮（22.1%）；验证集拦截 3688 次；未达阈值 4103 轮；训练对局 3108120 手。
- 接受时拟合 Δ：最小 +0.50 / 平均 +141.60 / 最大 +2279.08 BB/100。
- 接受轮次：第 3 轮 #3、第 6 轮 #2、第 7 轮 #1、第 11 轮 #1、第 15 轮 #1、第 22 轮 #1、第 25 轮 #3、第 38 轮 #2、第 39 轮 #2、第 40 轮 #2、第 43 轮 #2、第 46 轮 #2、第 49 轮 #1、第 51 轮 #1、第 52 轮 #2、第 54 轮 #1、第 60 轮 #1、第 65 轮 #2、第 66 轮 #1、第 68 轮 #2 等 2209 次。

### 专家（expert）

- 接受 2342/10000 轮（23.4%）；验证集拦截 3646 次；未达阈值 4012 轮；训练对局 3119040 手。
- 接受时拟合 Δ：最小 +0.50 / 平均 +135.61 / 最大 +1489.83 BB/100。
- 接受轮次：第 5 轮 #2、第 6 轮 #1、第 14 轮 #1、第 23 轮 #3、第 24 轮 #1、第 25 轮 #3、第 28 轮 #1、第 31 轮 #2、第 32 轮 #1、第 34 轮 #3、第 37 轮 #3、第 40 轮 #1、第 59 轮 #3、第 61 轮 #1、第 63 轮 #2、第 65 轮 #1、第 66 轮 #3、第 67 轮 #1、第 68 轮 #2、第 71 轮 #2 等 2342 次。

## 4. 最终关键参数

| 参数 | 入门 | 普通 | 困难 | 专家 |
| --- | ---: | ---: | ---: | ---: |
| `preflop.play` | 0.300 | 0.640 | 0.715 | 0.780 |
| `preflop.raise` | 0.866 | 0.810 | 0.768 | 0.911 |
| `preflop.threeBet` | 0.967 | 0.975 | 0.928 | 0.931 |
| `preflop.bluffRaiseRate` | 0.066 | 0.088 | 0.120 | 0.245 |
| `preflop.mixRaiseRate` | 0.459 | 0.028 | 0.224 | 0.329 |
| `preflop.trapRate` | 0.227 | 0.128 | 0.190 | 0.198 |
| `postflop.bluffRate` | 0.010 | 0.156 | 0.256 | 0.214 |
| `postflop.semiBluffRate` | 0.000 | 0.239 | 0.435 | 0.623 |
| `postflop.valueThreshold` | 0.547 | 0.578 | 0.698 | 0.620 |
| `postflop.callMargin` | 0.000 | 0.114 | 0.120 | 0.120 |

> `mcIterations`、`betSizes`、`raiseSizes`、`errorRate`、`positionAware`、`style`、`label` 不在变异范围内，四档保持基础档位设定。

## 5. 大模型机器人训练数据

- few-shot 经验条数：160 条（上限 160）
- SFT 数据集行数：101 行（上限 400）
- 经验库按街道：preflop 119、flop 30、turn 7、river 4
- 经验库按动作：fold 87、check 24、call 6、bet 14、raise 26、allin 3
- SFT 按街道：preflop 60、flop 30、turn 7、river 4
- SFT 按动作：fold 44、check 24、call 4、bet 14、raise 12、allin 3
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
