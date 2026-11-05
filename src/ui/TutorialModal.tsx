/** 新手教程弹窗：分页讲解规则、位置、操作、界面、AI 与训练。 */
import { useEffect, useRef, useState, type ReactNode } from 'react';

interface TutorialModalProps {
  onClose: () => void;
  onStartGame: () => void;
}

const HAND_RANKINGS: Array<{
  name: string;
  make: string;
  example: string;
  note: string;
}> = [
  {
    name: '皇家同花顺',
    make: 'A、K、Q、J、10 且同花色',
    example: 'A♠ K♠ Q♠ J♠ 10♠',
    note: '最大的牌型',
  },
  {
    name: '同花顺',
    make: '五张连续且同花色',
    example: '9♥ 8♥ 7♥ 6♥ 5♥',
    note: '按最大牌点比较',
  },
  {
    name: '四条',
    make: '四张同点数 + 一张踢脚',
    example: 'Q♣ Q♦ Q♥ Q♠ 7♦',
    note: '四条之间比点数',
  },
  {
    name: '葫芦',
    make: '三条 + 一对',
    example: 'J♠ J♦ J♣ 4♥ 4♠',
    note: '先比三条，再比对子',
  },
  {
    name: '同花',
    make: '五张同花色，不连续',
    example: 'A♦ J♦ 9♦ 6♦ 3♦',
    note: '花色本身不分大小',
  },
  {
    name: '顺子',
    make: '五张连续，花色可不同',
    example: '10♣ 9♦ 8♠ 7♥ 6♣',
    note: 'A 可作最大或最小',
  },
  {
    name: '三条',
    make: '三张同点数 + 两张踢脚',
    example: '8♠ 8♦ 8♣ K♥ 3♠',
    note: '先比三条，再比踢脚',
  },
  {
    name: '两对',
    make: '两个对子 + 一张踢脚',
    example: 'A♠ A♦ 5♣ 5♥ 9♠',
    note: '先比大对，再比小对',
  },
  {
    name: '一对',
    make: '一个对子 + 三张踢脚',
    example: 'K♠ K♦ Q♣ 9♥ 4♠',
    note: '从上到下依次比较',
  },
  {
    name: '高牌',
    make: '以上都不是，比单张',
    example: 'A♠ Q♦ 9♣ 6♥ 3♠',
    note: '没有成牌时的牌型',
  },
];

const AI_DIFFICULTIES = [
  {
    name: '入门',
    tag: '适合第一次玩',
    text: '按起手牌强度查表，偏松被动，偶尔会犯错；翻牌后主要看牌力与跟注成本。',
  },
  {
    name: '普通',
    tag: '默认难度',
    text: '起手牌范围结合位置，翻牌后比较牌力与底池赔率，晚位会少量诈唬。',
  },
  {
    name: '困难',
    tag: '会算胜率',
    text: '翻牌后用蒙特卡洛模拟胜率，听牌会半诈唬，下注尺度更丰富，少送钱。',
  },
  {
    name: '专家',
    tag: '最难',
    text: '更大样本的胜率模拟、根据对手行动收窄范围，并考虑 SPR 与多街计划。',
  },
];

function positionPage(): ReactNode {
  return (
    <>
      <div className="tutorial-columns">
        <div>
          <h3 className="tutorial-h3">位置名称</h3>
          <ul className="tutorial-list">
            <li>
              <strong>按钮位（D）</strong>：每手顺时针轮转；翻牌后最后行动，位置最好。
            </li>
            <li>
              <strong>小盲（SB）/ 大盲（BB）</strong>：按钮左侧两位，翻牌前强制投入盲注。
            </li>
            <li>
              <strong>枪口位（UTG）</strong>：大盲左侧第一位，翻牌前最先行动。
            </li>
            <li>
              <strong>中间位 / 劫位 / 关位</strong>：越靠后，能先观察前面玩家的行动。
            </li>
          </ul>
        </div>
        <div>
          <h3 className="tutorial-h3">行动顺序</h3>
          <ul className="tutorial-list">
            <li>
              <strong>翻牌前</strong>：从大盲左侧第一位开始顺时针，大盲最后行动。
            </li>
            <li>
              <strong>翻牌 / 转牌 / 河牌</strong>：从按钮左侧第一位未弃牌玩家开始，按钮最后。
            </li>
            <li>
              <strong>大盲 option</strong>：翻牌前无人加注时，大盲跟注后仍可过牌或加注。
            </li>
            <li>
              <strong>单挑（2 人）</strong>：按钮兼小盲；翻牌前按钮先行动，翻牌后大盲先行动。
            </li>
          </ul>
        </div>
      </div>
      <div className="tutorial-callout">
        <strong>盲注与全下：</strong>
        小盲/大盲是强制投入。筹码不足时，跟注会自动变成全下；多人全下会按投入分成主池与边池，
        每个底池只由有资格且未弃牌的玩家竞争。牌桌会在底池区域显示边池结算。
      </div>
      <p className="tutorial-note">
        提示：牌桌上座位旁的 <strong>D / SB / BB</strong> 徽标能帮你快速确认按钮位与盲注位。
      </p>
    </>
  );
}

function actionPage(): ReactNode {
  return (
    <>
      <div className="tutorial-action-grid">
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">弃牌</span>
          <p>放弃本手牌，已投入的筹码留在底池。可以弃牌时按钮才可点。</p>
        </div>
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">过牌</span>
          <p>无人下注时跳过行动，不投入筹码；有人下注时不能过牌。</p>
        </div>
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">跟注</span>
          <p>补齐到当前下注额。跟注金额超过剩余筹码时会自动全下。</p>
        </div>
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">下注 / 加注</span>
          <p>
            无人下注时是「下注」，面对下注时是「加注」。金额表示<strong>本街累计加到</strong>
            多少，不是额外增加多少。
          </p>
        </div>
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">全下</span>
          <p>把全部剩余筹码推入底池。短全下可能不重开已行动玩家的加注权。</p>
        </div>
        <div className="tutorial-action-card">
          <span className="tutorial-action-card__title">滑块与输入框</span>
          <p>拖动滑块或输入整数，操作区会实时校验最小 / 最大合法金额。</p>
        </div>
      </div>
      <div className="tutorial-callout">
        <strong>快捷尺度：</strong>
        提供「最小 / 1/2 底池 / 2/3 底池 / 底池 / 全下」按钮。点击后会按当前合法范围自动夹取，
        不会产生非法下注。数字输入框失焦或按 Enter 时会自动规整到合法范围。
      </div>
      <p className="tutorial-note">
        盲注无需你手动投入，发牌时自动扣除。你只需在自己的回合选择动作；
        操作区会在轮到你时自动滚动到视野内。
      </p>
    </>
  );
}

function interfacePage(): ReactNode {
  return (
    <>
      <ul className="tutorial-guide">
        <li>
          <strong>座位卡：</strong>显示玩家名称、筹码、底牌、本轮下注、D/SB/BB 位置以及
          行动中 / 已弃牌 / 全下 / 已淘汰状态。大模型机器人有 <span className="seat__llm-badge">LLM</span>{' '}
          徽标与 🤖 头像。
        </li>
        <li>
          <strong>公共牌与底池：</strong>牌桌中央依次发出翻牌 3 张、转牌 1 张、河牌 1 张；
          底池横幅实时显示总底池与当前下注，本手结束后显示主池 / 边池的分配结果。
        </li>
        <li>
          <strong>操作区：</strong>在牌桌下方，包含动作按钮、下注滑块、数字输入与快捷尺度；
          轮到你行动或本手结束时自动滚入视野。
        </li>
        <li>
          <strong>牌局日志：</strong>右侧日志按发牌 / 盲注 / 动作 / 公共牌 / 摊牌 / 底池分类着色，
          可切换「本手 / 全部」，并自动滚动到最新一条。
        </li>
        <li>
          <strong>调试面板：</strong>开启设置栏「调试模式」后显示最近 10 条 AI 决策：
          来源（本地算法 / 大模型）、模型名、耗时、胜率、底池赔率、理由与可折叠的原始响应。
        </li>
        <li>
          <strong>历史回放：</strong>牌桌右上角「牌局历史」可查看每手公共牌、各玩家底牌、
          筹码变化、底池结果与完整日志；「导出历史」可保存为 JSON。
        </li>
        <li>
          <strong>设置栏：</strong>难度、人数、速度、随机种子、调试模式、训练参数开关、
          新手教程、AI 玩家设置，以及「新局 / 下一手 / 重置筹码 / 导出历史」。
        </li>
      </ul>
      <div className="tutorial-callout">
        <strong>不会自动开局：</strong>
        首次进入或重开页面时，牌桌处于闲置状态。看完教程后点「开始对局」才会发牌；
        每手结束后点「下一手」继续。
      </div>
      <div className="tutorial-callout">
        <strong>随机种子：</strong>
        设置栏「随机种子」留空时，每次「新局 / 重置筹码」都会自动生成新的随机种子，
        所以每局发牌都不一样；设置栏会显示「本局实际种子」，把它填回输入框即可复现同一副牌。
        固定种子 + 相同操作 = 完全相同的一局。
      </div>
    </>
  );
}

function aiPage(): ReactNode {
  return (
    <>
      <div className="tutorial-difficulty-grid">
        {AI_DIFFICULTIES.map((item) => (
          <div className="tutorial-difficulty-card" key={item.name}>
            <div className="tutorial-difficulty-card__head">
              <strong>{item.name}</strong>
              <span>{item.tag}</span>
            </div>
            <p>{item.text}</p>
          </div>
        ))}
      </div>
      <div className="tutorial-callout tutorial-callout--llm">
        <strong>大模型玩家、名字与 AI 军师（全部可选）：</strong>
        <p>
          设置栏点「AI 玩家设置」可以添加多个大模型玩家（数量由人数决定：2 人桌最多 1 个，6 人桌最多
          5 个）。每个玩家都可以自由编写<strong>名称</strong>和<strong>人物设定</strong>（性格 / 说话风格
          / 打法倾向），人物设定会写进提示词。弹窗会自动扫描本机 Ollama / LM Studio / vLLM /
          llama.cpp 服务，也可手动填写 Base URL、模型名、API Key、温度、超时与输出 token 上限。
        </p>
        <p>
          <strong>省 token：</strong>提示词是精简英文，动作要求一行短键 JSON；「神态语句」开关打开后，
          模型行动时会附带一句短台词（会多消耗少量 token）；「AI 军师」是你自己的中文教练兼聊天伙伴，
          只在点「分析当前局势」或发送消息时调用，可随时关闭。
        </p>
        <p>
          <strong>体验随机：</strong>本地算法机器人每局会被随机分配一种风格原型（紧凶 / 松凶 / 紧弱 /
          跟注站 / 疯子 / 均衡），风格只在难度允许范围内小幅调整参数；同一局里还会随机化下注尺度、
          偶尔慢玩或抢池、思考时间也有抖动。开启「神态语句」后本地机器人也会偶尔说一句台词（纯表演，
          不影响规则）。换一个新局（新种子）会重新洗牌整桌风格组合。
        </p>
        <p>
          大模型只会收到公开信息与自己的底牌，不会看到对手底牌。行动失败或超时会自动回退本地算法并继续
          牌局；思考型模型如果因“思考”耗尽 token 返回空内容，会自动重试并放宽上限。每手结束后，模型会把
          自己这手的动作与结果写入浏览器本地「对局记忆」（每个模型最多 80 条），可在设置里单独清空。
        </p>
        <p>
          「AI 玩家设置 → 玩家名称」里，你自己的名字和本地算法机器人的名字也都可以自由修改。
          Ollama 需设置环境变量 <code>OLLAMA_ORIGINS=*</code>；LM Studio 需在本地服务器设置中开启 CORS。
          人数不足时会给出中文提示，请增加人数或减少启用的大模型玩家。修改后点「新局」重新入座。
        </p>
      </div>
    </>
  );
}

function trainingPage(): ReactNode {
  return (
    <>
      <h3 className="tutorial-h3">训练本地 AI 参数</h3>
      <ol className="tutorial-steps">
        <li>
          <strong>启动训练：</strong>双击项目根目录的 <code>训练机器人.bat</code>，
          或在命令行运行 <code>npm run train</code>。
        </li>
        <li>
          <strong>交互式确认：</strong>双击后会先询问训练轮数（1–10），并给出预计耗时，
          输入 <code>Y</code> 确认后才开始训练；训练全程本地运行、不需要联网。
        </li>
        <li>
          <strong>两类机器人都被训练：</strong>规则引擎机器人通过自博弈进化四档参数；
          大模型机器人则获得 few-shot 经验库与可选微调数据集（<code>training/llm-sft-dataset.jsonl</code>）。
          训练报告见 <code>training/REPORT.md</code>。
        </li>
        <li>
          <strong>开启训练后参数：</strong>回到页面，刷新后若设置栏出现「使用训练后参数」开关，
          保持开启即可。开关状态会保存在 localStorage，下次访问仍然生效。
        </li>
      </ol>
      <div className="tutorial-callout">
        <strong>训练数据已加载 / 未生成：</strong>
        设置栏在检测到可用训练参数时会提示「训练数据已加载」，并显示「使用训练后参数」开关。
        没有检测到训练参数时，AI 使用内置默认策略。训练只调整 AI 风格参数，不改变牌局规则。
      </div>
      <div className="tutorial-columns">
        <div>
          <h3 className="tutorial-h3">本地数据说明</h3>
          <ul className="tutorial-list">
            <li>教程完成标记、AI 玩家设置、训练开关保存在浏览器 localStorage。</li>
            <li>大模型对局记忆仅保存在本机浏览器，最多保留最近若干条。</li>
            <li>不登录、不上传、不使用外部付费服务。</li>
          </ul>
        </div>
        <div>
          <h3 className="tutorial-h3">推荐流程</h3>
          <ul className="tutorial-list">
            <li>先选人数与难度（2–6 人，四档难度）。</li>
            <li>需要大模型时先在「AI 玩家设置」测试连接，再点「开始对局」。</li>
            <li>新手先用「入门 / 普通」难度，熟悉位置与下注尺度。</li>
            <li>想复盘时打开「调试模式」与「牌局历史」。</li>
          </ul>
        </div>
      </div>
      <p className="tutorial-note">
        现在点「开始对局」就会按当前设置发牌；如果暂时不想玩，点右上角 × 关闭教程，
        页面会停留在大厅，不会自动开局。
      </p>
    </>
  );
}

const PAGES: Array<{ title: string; subtitle: string; content: ReactNode }> = [
  {
    title: '游戏目标与牌型',
    subtitle: '用最强的五张牌赢下底池',
    content: (
      <>
        <p className="tutorial-lead">
          每位玩家发两张底牌，桌面上依次发出五张公共牌。用「两张底牌 + 五张公共牌」中的
          <strong>任意五张</strong>组成最大牌型，牌型最大者赢得底池。
        </p>
        <div className="hand-table-wrap">
          <table className="hand-table">
            <thead>
              <tr>
                <th scope="col">牌型（从大到小）</th>
                <th scope="col">组成</th>
                <th scope="col">示例</th>
                <th scope="col">比较规则</th>
              </tr>
            </thead>
            <tbody>
              {HAND_RANKINGS.map((item, index) => (
                <tr key={item.name}>
                  <th scope="row">
                    <span className="hand-table__rank">{index + 1}</span>
                    {item.name}
                  </th>
                  <td>{item.make}</td>
                  <td className="hand-table__example">{item.example}</td>
                  <td>{item.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="tutorial-columns">
          <div>
            <h3 className="tutorial-h3">A 可大也可小</h3>
            <p>
              A 可以作为最大牌组成 A-K-Q-J-10，也可以作为最小牌组成 A-2-3-4-5。
              但 <strong>Q-K-A-2-3 不算顺子</strong>。
            </p>
          </div>
          <div>
            <h3 className="tutorial-h3">7 选 5 与平局</h3>
            <p>
              你手里最多有 7 张牌（2 张底牌 + 5 张公共牌），从中选最强的 5 张，不使用其余牌。
              如果牌型与踢脚完全相同，则平分底池；无法平分的奇数筹码按规则分给相应玩家。
            </p>
          </div>
        </div>
        <p className="tutorial-note">花色（♠ ♥ ♦ ♣）只用于组成同花，花色之间不分大小。</p>
      </>
    ),
  },
  {
    title: '位置与行动顺序',
    subtitle: '按钮、盲注与谁先说话',
    content: positionPage(),
  },
  {
    title: '操作说明',
    subtitle: '从弃牌到全下',
    content: actionPage(),
  },
  {
    title: '界面导览',
    subtitle: '每个面板有什么用',
    content: interfacePage(),
  },
  {
    title: 'AI 难度与大模型机器人',
    subtitle: '四档本地算法 + 两个可选大模型',
    content: aiPage(),
  },
  {
    title: '训练与进阶',
    subtitle: '让本地 AI 更符合你的风格',
    content: trainingPage(),
  },
];

export function TutorialModal({ onClose, onStartGame }: TutorialModalProps) {
  const [page, setPage] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastPage = PAGES.length - 1;
  const current = PAGES[page];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [page]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal tutorial-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tutorial-title"
      >
        <header className="modal__header">
          <div>
            <p className="modal__eyebrow">新手教程 · {page + 1} / {PAGES.length}</p>
            <h2 className="modal__title" id="tutorial-title">
              {current.title}
            </h2>
            <p className="modal__subtitle">{current.subtitle}</p>
          </div>
          <button type="button" className="modal__close" onClick={onClose} aria-label="关闭教程">
            ×
          </button>
        </header>

        <div className="tutorial-progress" aria-hidden="true">
          <span style={{ width: `${((page + 1) / PAGES.length) * 100}%` }} />
        </div>

        <div className="tutorial-body" ref={bodyRef}>
          {current.content}
        </div>

        <footer className="modal__footer tutorial-footer">
          <div className="tutorial-dots" aria-hidden="true">
            {PAGES.map((item, index) => (
              <span key={item.title} className={index === page ? 'is-active' : ''} />
            ))}
          </div>
          <div className="tutorial-nav">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              disabled={page === 0}
            >
              上一步
            </button>
            {page < lastPage ? (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setPage((value) => Math.min(lastPage, value + 1))}
              >
                下一步
              </button>
            ) : (
              <button type="button" className="btn btn--primary" onClick={onStartGame}>
                开始对局
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
