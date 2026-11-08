# 架构设计 — v0.26「挑战宗师做加法」

**作者**：高见远（架构师）· **日期**：2026-11-08 · **基线**：v0.25.1（`b36e1ee`）
**输入**：`docs/PRD-v0.26-挑战宗师.md`、`docs/交接说明书.md`、`AGENTS.md` 第 0/1–15 条
**约束**：专家档一个字节不动；不加 LLM/外部 API；本次只出设计，不改代码。
**标记**：【实测】有脚本有样本；【估算】有依据的推断；【未验证】只有代码或注释。

---

## 0. 五条先说

1. **+6.3 只代表 5 个原型里的 1 个。** `head2head.ts:69`、`h2h-shard.ts:58`、`session.ts:49`、`session-paired.ts:51` 全把 `challengeArchetypeId` 钉成 0，实战却由 `stateMachine.ts:285-292` 按 seed 分配。实战平均**未知且大概率低于 +6.3**（3/5 原型诈唬率高于专家）。这是第一件要测的事。
2. **最便宜的真增量是回收 C1 的松弛**：证据链现成（`difficulty.ts:244-246`：三层合计 +66、净值 +1.8），预期 +5~+25【估算】，0.5 人日。
3. **翻牌三层精确求解不可行**：树是现在的 9·Kt 倍，Kt=3 时 **27 倍 ≈ 4.9 秒/决策**，超 400ms 预算 12 倍。可行路线只有「范围感知价值网络 + 受限树」，而现网络输入里**没有对手范围**（`turnValue.ts:84-110`）——R² 提到 0.70 也修不了这个模型类错误，**P0-3 的判定对象必须改**。
4. **PRD P1-3 的「覆盖率 14.2%→60%」在「全部决策」口径下不可达**：转+河只占 **32.3%（41/127）**（§1.2 实测）。必须换分母。
5. **诚实预期：v0.26 达 +50 的概率约 20~30%**【估算】。建议 T1 出数后立刻与需求方对齐「达不到写什么」。

---

## 1. 事实复核（三处口径要改）

**1.1 C1 成立，漏的是「诈唬」，不是 `callMargin`。** `applyChallengeVariant`（`challenge.ts:146-169`）在基准 0.16/0.05 上再乘原型系数：

| 原型 | bluff | bluffRate | vs 专家 0.16 | semiBluff（专家 0.38） | callMargin |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 均衡 | 1.00 | 0.160 | 持平 | 0.399 | 0.050 |
| 1 压力 | 1.55 | 0.248 | **+55%** | 0.441 | 0.048 |
| 2 陷阱 | 0.65 | 0.104 | −35% | 0.372 | 0.047 |
| 3 反制 | 1.15 | 0.184 | **+15%** | 0.410 | 0.045 |
| 4 混沌 | 1.35 | 0.216 | **+35%** | 0.426 | 0.053 |

修正 PRD 一处：`callMargin` 到不了 −0.05——基准已抬到 0.05，`(exploit−1)×0.02 ≤ 0.005`，实际 0.045~0.053（`challenge.ts:165-167`）。5 原型平均 bluffRate = 0.1824（+14%）。

**1.2 覆盖率口径**【本次实测，60 手，`_diag-engines` KIND=expert CHALLENGE=1】**样本只够看结构、不够看比例**（60 手，单格 95% CI 约 ±7~11pp；下面的百分比标【估算】）：127 次决策：翻前 57（44.9%，其中蓝图 44 + 剥削 11）、**翻牌 29（22.8%【估算】，100% 启发式）**、转牌 23（18.1%）、河牌 18（14.2%）、启发式兜底 50（39.4%）。⇒ **转+河共 41 次（32.3%）**，已解 22 次 = **转河内部 53.7%**。建议指标改成「非启发式占全部决策」（现 **77/127 = 60.6%**）+「转河内部覆盖」（现 53.7%）。
**据此可反算 `P1-3a` 的目标**【第二轮实测按街拆分：翻前 57 = 蓝图 44 + 剥削 11 + **启发式 2**、翻牌 29、**转牌 23（已解 18）**、**河牌 18 = 面对下注 4（全解）+ check 到我 14（全启发式）**】：**反算公式（当前引擎形态下）** `非启发式 = 55 + 41×c + 29×f`（55 = 翻前非启发式；c = 转河内部覆盖率，f = 翻牌命中率；目标 0.75×127 = 95.25）。现状 77/127 = 60.6%（c=53.7%，f=0）；**不开 checked-to 时 c 的「当前引擎形态下结构上限（乐观）」65.9%（27/41）→ 全决策 64.6%**（乐观 = 假设 5 个未解的转牌启发式全都能解；若哪天 checked-to 做出正贡献，此上限整体上移，不得当定理）。三条达成路径：**A**（c=85%）需 f≥19%；**B**（c=**61.0% = 25/41**，即转牌 18+3=21 个 + 河牌面对下注 4 个）需 f≥**54%**（精确 15.25/29 = 52.6%，PRD 向上取整为 54%）；**C**（c=53.7%）需 f≥63%。**`P1-3b` 的降级目标是 ≥60%（25/41 = 61.0%），不是 65%**：可达值只能取整数决策、按 1/41 = 2.44pp 跳——26/41 = 63.4%、27/41 = 65.85%，65% 夹在两者之间，唯一路径是 27/41（吃满天花板），所以 65% 不是退路。建议 **`P1-3a` ≥75%**，任一路径即可；若都判负则停在 60.6%，届时重谈而不是硬扛。**注意 c 与 f 互相影响**（翻牌解决的问题越多，下游决策条数越少），上式是近似，验收以 `_diag-streets` 实测为准。

**1.3 「翻牌零差异」要写准。** 翻牌走同一个 `decideExpertPostflop`（`aiPlayer.ts:1876-1881`），但输入不同（挑战：蓝图范围 + 30000 MC；专家：`reads` 范围 + 20000 MC，`aiPlayer.ts:1922-1929`）。所以 R3 要换的是**决策依据**，不是加个函数。

---

## 2. 路线选型

| 路线 | 预期增量 BB/100 | 成本 | 主要风险 | 失败概率 |
| --- | --- | ---: | --- | ---: |
| **R1** 夹紧原型松弛 | +5 ~ +25【估算】 | 0.5 人日 | 5 个原型「性格」变淡（产品取舍） | 35% |
| **R2** 基准覆盖全原型 + HLB | 0（纯测量） | 1.5 人日 | 现有 +6.3 结论作废，文档要重写 | 5% |
| **R3(a)** 范围感知价值网络 + 受限翻牌树 | +10 ~ +35【估算】 | 7 人日 | 第 4 次翻牌失败；标签噪声压 R² | 60% |
| **R3(b)** 翻牌→转河精确联合 | — | — | **超预算 12 倍，不批准** | 95% |
| **R3(c)** 仅翻牌频率表（无树无网络） | 0 ~ +15【估算】 | 2 人日 | 与 (a) 重复投入；历史 −19 | 65% |
| **R4** 3-bet 底池多街一致性 | +3 ~ +12；对 HLB-1 +10~+30【估算】 | 2 人日 | head2head 测不出来（专家不针对此漏洞） | 40% |
| **R5** 转河覆盖率 14.2→60% | −5 ~ +5 | 2 人日 | 现有定论 −2.1 中性，等于放大中性策略 | 70% |
| **R6a** 河牌「被过牌」也求解 | 负 | — | 历史 −10.1 vs −4.9（`aiPlayer.ts:94-95`），**不批准** | — |
| **R6b** closeness 0.92 定量扫描 | −5 ~ +10 | 1 人日 | 无，纯消融 | 50% |

**R1**：只允许在**非漏洞维度**上高于专家基准。夹紧 `preflop.bluffRaiseRate`、`postflop.bluffRate`、`postflop.semiBluffRate`（乘子上限 1.0），`callMargin` 下限抬回 0.05；保留 `sizing`/`trap`/`timingStyle`/`mixRaiseRate×aggression`/`exploit`（只许向下）。「全夹到 1.0」会把 5 个原型压成一个，不做。
**R2**：`head2head` 增 `ARCH=assign`（按 `assignChallengeArchetypes(seed, 两座位 id)`，与 `stateMachine.ts:285` 一致）+ `NEW_CLAMP=1`。A 口径（现状真相）= `ARCH=assign OLD=0`；B 口径（R1 增量）= `ARCH=assign OLD=1 NEW_CLAMP=1`（同原型对同原型）。`session-paired.ts:51` 同样要加 `ARCH`，否则 `FLAG` 消融在原型 0 上恒为 0。

**R3 时间预算核算**（依据 `subgameTurn.ts:96-235` 树结构 + 181ms/160iter/20combo/3 河桶实测）：

| 项 | 数值 |
| --- | --- |
| 现树每迭代摊牌节点 | 9 个「本街结束」× 3 河桶 × 9 个河牌摊牌 = **243** |
| 每摊牌 | 2×nH×nV = 800 次乘加 → 每迭代 ≈ 19.4 万次；160 迭代 3.1e7 → 181ms ⇒ ≈1.7e8 次/秒 |
| 加一层翻牌 | 9（翻牌本街结束）× Kt（转牌桶）× 243 = **2187·Kt** |
| Kt=3 | 6561 → **27 倍 ≈ 4.9 秒**；Kt=1 → 9 倍 ≈ 1.6 秒 |
| 塞进 400ms | 只能 13 次迭代（平均策略只覆盖最后 6 次）→ 无意义 |

⇒ **R3(b) 需 12 倍加速，只能靠「1 转牌桶 + 1 河桶 + 10 组合」，那是玩具抽象**；而 v0.24 已证「组合 24→40 = −44.5、翻前桶 24→48 更差」，抽象退化不是中性操作。**不批准。**

**(a) 的真障碍不是 R²，是输入少一维。** `turnValue.ts:84-110` 的 24 个特征全是「我的牌 + 牌面 + 底池 + 筹码」，**没有对手范围**。但叶子必须给出 (我方手牌, 对手手牌) 的收益结构，否则诈唬没有收益、解出来就是「不分强弱乱下注」。现实现靠人为补丁补救——`generate-flop-blueprint.ts:257-265`：`payoff[h][v] = meanEv[h] + (equity[h][v] − avgEquity[h])×pot×λ`，λ 是常数。**这个 λ 就是第三版翻牌蓝图 −19 的结构性来源**（翻牌后续价值取决于隐含赔率/抓诈能力，不是摊牌权益的线性函数），R² 到 0.70 也改不了。
⇒ 闸门改为：**范围感知网络（输入含对手 24 桶直方图，输出逐组合条件 EV）留出 R² ≥ 0.60、MAE ≤ 0.15 底池**。旧网络不动，另开 `turnValueV2.ts`。
**(c) 折中**：不做树，只做「翻牌范围优势 → 下注频率表」，离线配对消融校准。上限低（+15）但不会重蹈 λ 补丁——因为它不解树，不假装是均衡。

**R4**：`§4.2` 的 Q5s 根因不是翻前太宽，是**翻后不知道自己是 3-bet 方**（`decideExpertPostflop` 只看 SPR 与胜率；`preflop.ts:642-713` 能推 3-bet 线范围，但没有一处把「底池类型」分发给翻后）。方案：`readPotContext(view)` 识别 `limped/srp/3bet/4bet+` 与进攻方；仅 `challenge && 单挑 && 我方是 3-bet 方` 时叠加一层范围一致的下注计划（K/A 高干燥面 → 33% 小注高频；湿润面 → 低频大注），并给转牌 barrel 计划。**必须用 HLB-1 测**：专家不会专门利用「3-bet 后放弃」，head2head 会低估到 0。

**R5**：不批。转河内部已 53.7%，净值 −2.1（中性），把中性策略用得更勤期望 ≈0，风险是把 p90 从 227ms 推向 400ms。唯一值得提的覆盖率是翻牌（22.8%），那属于 R3。

**R6b**：`gtoClosenessFor(difficulty, challenge)` 挑战 0.92 / 专家 0.55，从未定量扫过。四臂 `{0.7,0.85,0.92,1.0}`，每臂 15,200 局 ≈19 分钟。对手是均衡型专家时过度剥削可能反而亏，值得先测（需加 `options.closeness`，默认 `undefined` 走原逻辑）。
**R6d**：`HU_SB_PREFLOP`（`aiPlayer.ts:129-135`）被翻前蓝图覆盖，是死代码（`交接说明书 §6.4`），动它等于动噪声。

---

## 3. 实施顺序

```
T1(R2 测量面) ─┬→ T2(R1 夹紧) → T5(R6b 扫描)
T3(冻结/白名单)─┤
T4(HLB 6 bot) ─┴→ T6(R4 3-bet 层) ─────────→ T9(验收)
T7(价值网络 v2 闸门) → T8(翻牌层) ──────────↗
```

同意「先 R1/R2 再 R3」，但补三条：① **T3 必须排在 T6 前**——T6 要改 `aiPlayer.ts` 的翻后分支，没有哈希冻结就是在赌；② **T4 必须排在 T6 前**——R4 的价值只在 HLB 上可见；③ **R4 排在 R3 前**——2 人日 vs 7 人日，且 R4 补的是真人对局证实的漏洞，R3 是三次失败后的第四次尝试。先花小钱补确定的洞，再赌大的。

---

## 4. 架构与文件清单

**新增**：`publicTreeCfr.ts`（从 `subgameTurn.ts:582-696` 抽出的通用公共树 CFR 内核，转河/翻牌共用）、`flopSolve.ts`（翻牌受限求解，`enabled:false`）、`turnValueV2.ts`（范围感知网络推理）、`postflopPlan.ts`（`readPotContext` + `planFlopBet`）、`turn-value-v2` 训练脚本、`_diag-streets.ts`（各街分布 + 引擎命中）、`expertFreeze.test.ts`、`archetypeBounds.test.ts`、`potContext.test.ts`。**HLB 6 bot 与配对差分工具已由 QA 实现**（`scripts/hlb-bots.ts`、`hlb-compare.ts`、`h2h-diff.ts`，口径与 §2/§6.2 一致），T4 只做自检与 6 bot 基线；**§5 的 Δ 门槛（T2/T5/T6/T8/T1b）一律以 `h2h-diff.ts` 的逐 seed 差分为准**。
**修改**：`challenge.ts:146-169`（policy 化）、`aiPlayer.ts:1741-1887`（挑战分支接线：`solveFlopLayer` → `planFlopBet` → 现有 `decideExpertPostflop`）、`subgameTurn.ts`（改用内核 + 输出 `valueByCombo`）、`head2head.ts`/`h2h-shard.ts`/`session-paired.ts`（`ARCH`/`NEW_*` 开关）。**专家分支零改动。**

```ts
// challenge.ts：策略参数化，默认夹紧；legacy 只给 A/B 用
export interface VariantPolicy { capBluff: boolean; floorCallMargin: boolean }
export function applyChallengeVariant(p: DifficultyProfile, id?: number, policy?: VariantPolicy): DifficultyProfile;

// publicTreeCfr.ts：与街无关的内核
export interface PublicTreeConfig {
  street: 'flop' | 'turn'; pot: number; toCall: number; effectiveStack: number;
  heroFirst: boolean; aggressiveType: 'bet' | 'raise' | null;
  betFractions: readonly number[]; raiseFractions: readonly number[];
  chanceBuckets: readonly number[];   // [转牌桶数, 河牌桶数]
}
/** 每个 hero 组合的条件 EV（筹码），已在 villain reach 上边缘化 */
export type LeafEvaluator = (ctx: {
  board: readonly Card[]; pot: number; heroInvested: number; villainInvested: number;
  heroCombos: readonly RangeEntry[]; villainCombos: readonly RangeEntry[];
}) => Float64Array | null;
export function solvePublicTree(view: PlayerView, cfg: PublicTreeConfig, leaf?: LeafEvaluator):
  { action: PlayerAction; strategy: number[]; valueByCombo: number[]; iterations: number; elapsedMs: number } | null;

// turnValueV2.ts：只比旧网络多一维——对手范围
export interface TurnValueV2Input {
  hole: readonly [Card, Card]; board: readonly Card[]; pot: number; callAmount: number;
  stack: number; canCheck: boolean;
  villainRange: Float64Array;  // 24 个翻前桶的归一化权重，顺序同 preflopBucketTable()
}
export function turnValueV2Forward(input: TurnValueV2Input): number; // EV / 底池

// postflopPlan.ts
export function readPotContext(view: PlayerView):
  { kind: 'limped'|'srp'|'3bet'|'4bet+'; aggressorId: number|null; heroIsAggressor: boolean; spr: number };
export function planFlopBet(ctx: DecisionContext, pot: PotContext, analysis: PostflopAnalysis):
  { betFrequency: number; sizeFraction: number; barrelTurn: boolean; reason: string } | null;
```

**时序（挑战档单挑）**：`profile = style → mood → exploit → applyChallengeVariant(policy)`（`aiPlayer.ts:1538-1545`）→ 翻前 `decidePreflop`；翻后河牌 `solveStreetSubgame`、转牌 `solveTurnRiver`（均现有）；翻牌 → `flopSolve.enabled ? solveFlopLayer(...) : (planFlopBet(...) ?? decideExpertPostflop(...))`。

**I1 的类型保证**：① 上述三个求解入口的入参只有 `PlayerView` + 自己的 `[Card,Card]`，`HandState`/`deck`/`burned` 不出现；② 新增静态测试：读 `src/ai/solver/*.ts` 全文，断言不含 `HandState`、`.deck`、`.burned`、对手 `holeCards`（白名单只允许 `view.self.holeCards`）；③ 视图白名单测试：`buildPlayerView()` 的 key 集合 ⊆ 白名单，新字段必须登记。

---

## 5. 任务分解

| # | 任务 | 文件 | 依赖 | 验收（怎么测 / 多少局） | 人时 |
| --- | --- | --- | --- | --- | ---: |
| T1 | 测量面：`ARCH=assign` + 街道分布 | `head2head.ts`、`h2h-shard.ts`、`session-paired.ts`、`_diag-streets.ts` | — | 复跑 80,000 局（**须显式 `OLD=0`**）仍得 +6.3 **`[−8.9,21.5]`**：只读 `seeds/games/bbPer100` + **`pairedBySeed.ci95`** + `corrSameSeed`——`h2h-combine.ts` 顶层 `ci95` 是 naive 口径，读它会得到 [−6.5,19] 并被误判成「复现失败」；`ARCH=assign` 跑 15,200 局出「实战平均」 | 12 |
| T1b | **转河求解器配对 A/B**（`NEW_SOLVER=1` vs `0`）——整个「三层增量」前提从未用配对口径测过 | 现有 `head2head.ts` 开关 | T1 | 15,200 局，报 Δ 与 `sdDiffBB`；60-seed 试点 Δ+71.5 [−37,180] 不可当证据 | 4 |
| T2 | R1 夹紧 + A/B | `challenge.ts`、`archetypeBounds.test.ts` | T1 | 15,200 局配对差分：**Δ≥0 且 CI 下界>−15**（非劣界取 ≈1×SE(Δ)≈5 的三倍，`−5` 在真实 Δ=0 时只有 17% 通过率，等于要求「必须有正向证据」）；否则回滚 | 8 |
| T3 | 专家冻结 + I1 白名单 | `expertFreeze.test.ts`、`solver.test.ts` | — | 200 手 SHA-256 入库；同次运行断言翻/转/河/3-bet 场景计数均>0 | 6 |
| T4 | HLB 6 bot **转正与验收**（`hlb-bots.ts` / `hlb-compare.ts` 已由 QA 实现并改名，口径与本节设计一致） | `hlb-bots.ts`、`hlb-compare.ts` | T1 | 每 bot 跑两次输出逐位相同；6 bot × 2 档 × **1,800 手**出基线表。**分辨率只有 ±69**（SD_diff=14.94、SE=35.2）：能抓 −98 量级退化，抓不住 −20 的慢性退化 → 只写「A3 保证无 ≥69 量级的退化」，不许写成「保证不回退」 | 4 |
| T5 | R6b closeness 四臂 | `gto.ts`（加 `options.closeness`）、`head2head.ts` | T1 | **选臂与确认用不重叠 seed**：0..7599 选臂，7600..15199 确认（否则 4 臂取最大虚高 ≈1.03σ ≈ +5 BB/100，足以把噪声赢家判成突破） | 8 |
| T6 | R4 3-bet 层 | `postflopPlan.ts`、`aiPlayer.ts:1741`、`potContext.test.ts` | T3、T4 | HLB-1 差分 Δ≥0；15,200 局 **Δ≥0 非劣**（SE(Δ)=4.93：能证 +14 以上、证不了 +10 以下）；**首轮落 (+5,+15) 按「未决」追加**，与 T8 同规则；`play-as-human` 重放 Q5s 不再三街全过牌 | 16 |
| T7 | 价值网络 v2 闸门 | `subgameTurn.ts`（`valueByCombo`）、`turnValueV2.ts`、`train-turn-value-v2.ts` | T3 | `SAMPLES=12000`，留出 R²≥0.60 且 MAE≤0.15 底池；**不达标即终止 R3** | 20 |
| T8 | 翻牌受限求解 | `publicTreeCfr.ts`、`flopSolve.ts`、`aiPlayer.ts` | T7 | 同 seed 下与现 `subgameTurn` 策略哈希逐位相同；翻牌 p90≤250ms；15,200 局 **Δ≥+15 且 CI 下界>0**（SE(Δ)≈4.95：θ=+15 功效 86%、θ=+10 仅 52%，与 PRD P1-1/P1-2 对齐）；**CI 跨 0 且上界≥+10 判「未决」追加一批**；**加第三臂 `flopSolve + equity/λ 叶子`**，用 `Δ(arm2−arm1)` 单独判 V2 的净贡献 | 42 |
| T9 | 最终验收与文档 | README、本文件、产物 | T2,T6,T8 | 15,200 局挑战 vs 专家；A1–A4 全跑；冻结测试绿。**若 T6/T8 双双「未决」**：二者非互斥、开关独立，各自按非劣保留；但只追加 **T8** 一批（累计 29,000 局）定论——T8 不确定性更大、对 +50 的贡献上限更高，T6 只按「点估计≥0」取舍；两者的 README 一律写「噪声内」，发布门槛仍按**组合**测 | 12 |

合计 ≈ **130 人时**（不含机时；单批 15,200 局 ≈19 分钟，配对差分是跑两批 + 秒级合并，T5 选臂/确认共 4 批 ≈80 分钟，T8 三臂消融 + 翻牌计时约 2.5 小时）。

---

## 6. 质量闸门

**6.1 专家冻结（可执行）** `expertFreeze.test.ts`：① 断言 `profileSignature(expert)` 不变；② 固定 seed 跑 200 手（`challenge:false`，style 走真实分配），把 `(street,type,amount)` 拼串取 SHA-256 与入库常量比对；③ 同次运行断言「翻牌>0、转牌>0、河牌>0、3-bet 底池>0」——否则哈希没覆盖到该覆盖的东西；④ **不允许**在 T6/T8 的提交里更新哈希。哈希变了只有两种解释：故意提升专家档（需需求方书面同意）或 bug。

**6.2 每阶段 A/B** 单臂用 `h2h-shard.ts` 8 进程 + `h2h-combine.ts`（**7,600 seed = 15,200 局 ≈19 分钟**，只读 `pairedBySeed.ci95`，同时报 `corrSameSeed`，ρ 从 0.42 掉到 <0.25 说明配对失效）；**凡是 Δ 口径（T2/T5/T6/T8/T1b）必须用 `_h2h-diff.ts` 做同 seed 配对差分**，不许拿两条单臂 CI 目测相减。**每次都必须报 `sdDiffBB` 并据当次 sd 反推样本量，不许套固定表**：QA 实测「求解器开关」的 sdDiffBB=4.3（单臂 18.4，方差缩减 18 倍）⇒ 15,200 局 SE(Δ)≈4.95、可分辨 **±14**（80% 功效）；换一个改动配对程度会变。Δ 点估计≥门槛**且** CI 下界>0 才算增量，CI 重叠一律写「噪声内」。每改动另跑三对手回归（各 800 手）+ v0.3.0 对照。**完整口径实现见 `docs/测量规范.md`（本文只写判定门槛，不复制实现细节）。**

**6.3 必须停下重设计的红线**

| 触发 | 动作 |
| --- | --- |
| T1：`ARCH=assign` 下挑战 vs 专家 **CI 上界 < +10** | 做完 T2 仍不行，就**放弃 +50 并上报需求方**，不许偷改门槛 |
| T2：夹紧后 Δ<0 且 CI 下界<−15 | 回滚，并**改写** `difficulty.ts:244-246` 的注释（那条 +66 不成立于原型维度） |
| T7：20,000 样本后 v2 R²<0.60 | **终止 R3**（第 4 次翻牌失败），转 R3(c) 或冻结在 R1+R4 |
| T8：Δ<+15 且 **CI 上界 < +10** | 关开关，README 写「实测为负贡献，默认关闭」，本版不上翻牌层；CI 跨 0 且上界 ≥+10 判「未决」，追加一批再判（不许当成失败） |
| 任一阶段 p90>400ms | 强制降载回退启发式（I10），不许「偶尔慢」 |

---

## 7. 风险与待确认

**没把握的地方**：① `difficulty.ts:244-246` 的 +66【未验证】是「两次独立测量的差」，不是同 seed 配对 A/B，2800 局按 ρ=0.42 算 SE≈41（非配对）/≈8（配对），可信度差 5 倍——**R1 的论证不再引用它，改由 T1b（求解器配对 A/B）与 T2 自己的实测支撑**；在 T1b 出数前，那条注释只能当线索。② R3(a) 的 R² 天花板可能顶着标签噪声（标签来自 160 迭代/20 组合），20,000 样本约 1 小时，结论可能是否定的。③ 翻牌 p90 250ms 未必守得住（现转河「无人下注」分支已 350ms，`subgameTurn.ts:118`）；退路是只在「3-bet 底池 + 单加注底池的 check 分支」启用。④ **A4 探针可行性（回答 PRD §6 待定项）**：可行，`subgameTurn.ts:644/680` 已有 `evaluateOnly` 通路，再加「hero 侧固定外部策略、villain 侧跑 regret matching」的入口约 80 行，**估 0.5 人日 + 300 局约 20 分钟**。⑤ HLB 是我们自己写的 bot，差分会被「新层恰好针对它」污染，A3 只能当弱证据。

**需要拍板**：

| # | 问题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| D1 | +50 是硬门槛吗 | 保留 / 降到 +30 / 改成「CI 下界>0」 | 保留 +50，但**现在**就确认 v0.26 达不到时 README 怎么写（PRD §1 口径不变） |
| D2 | 5 个宗师的「性格」能否牺牲 | 全夹紧（最淡）/ 只夹松参数 | 只夹松参数 + 用 sizing/trap/timing 保留差异 |
| D3 | 单次决策时间上限 | 维持 400ms / 翻牌允许 800ms | 维持 400ms，翻牌单独设 p90 250ms |
| D4 | R3 第 4 次失败是否接受小增量 | 接受 / 换路线 | 接受并如实写进 README，不做第 5 次翻牌尝试 |

---

## 8. 一句话

**先把尺子修到能看见 5 个原型（T1），再用最便宜的方式回收已被证明在漏的那 64 点（T2），用冻结测试与 HLB 守住专家档和真人漏洞（T3/T4/T6），然后在「范围感知价值网络」这道闸门后面，才允许动占 22.8% 决策的翻牌（T7/T8）；翻牌三层精确求解在 400ms 预算下贵 12 倍，不批准。**
