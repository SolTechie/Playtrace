import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Check, Copy, Monitor, Pencil } from 'lucide-react';
import { useStore } from '../App';

// Instructions only: no task submission, device pairing, polling or local AI execution.
export default function Studio() {
  const { games } = useStore();
  const [params] = useSearchParams();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const target = games.find((game) => game.id === params.get('game'));
  const theme = params.get('kind') === 'theme';
  const request = theme
    ? '请帮我规划一个玩迹游戏专题。先询问我想聚合的游戏范围，再建议标题、简介和筛选条件，供我检查。'
    : target
      ? `请帮我核实以下游戏的资料，并寻找官方封面和截图。发行时间只记录年份；未知资料留空；保留已有的游玩时长、状态和个人评价。先展示建议修改的内容，等我检查。\n\n游戏名称（资料）：${JSON.stringify(target.title)}\n英文名称（资料）：${JSON.stringify(target.english_title)}\n玩迹记录 ID：${target.id}`
      : '请先询问我要添加哪款游戏，再核实游戏名称、开发商、发行年份、分平台 MC 评分，并寻找官方封面和截图。未知资料留空，不推测我的游玩时长、状态和个人评价。先整理资料供我检查。';
  return (
    <div className="desktop-ai-page">
      <Link className="back-link" to={target ? `/games/${target.id}` : '/'}>
        <ArrowLeft size={17} />
        {target ? '返回游戏详情' : '游戏库'}
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">AI ON YOUR DESKTOP</p>
          <h1>
            在电脑上，整理玩迹<span className="accent">。</span>
          </h1>
          <p className="muted">在自己的电脑上主动使用 AI，检查资料后再记录。</p>
        </div>
        <Monitor size={30} className="accent" aria-hidden="true" />
      </div>
      <p className="notice">网页 AI 任务和电脑自动连接已停用。游戏浏览与手动编辑可以继续使用。</p>
      <div className="desktop-ai-grid">
        <section className="desktop-ai-card" aria-labelledby="desktop-ai-steps">
          <h2 id="desktop-ai-steps">从自己的电脑开始</h2>
          <ol>
            <li>
              <strong>打开桌面 AI 助手</strong>
              <p>在电脑上打开 Codex，自己发起资料整理请求。</p>
            </li>
            <li>
              <strong>核实资料，检查修改</strong>
              <p>让 AI 查找游戏资料和图片，确认游戏版本、年份和评分。</p>
            </li>
            <li>
              <strong>保存到玩迹</strong>
              <p>目前可将整理好的资料填入游戏表单，上传图片后保存。</p>
            </li>
          </ol>
          <Link className="button primary" to={target ? `/games/${target.id}/edit` : '/games/new'}>
            <Pencil size={17} />
            {target ? '编辑这款游戏' : '手动添加游戏'}
          </Link>
        </section>
        <section className="desktop-ai-card" aria-labelledby="desktop-ai-request">
          <h2 id="desktop-ai-request">带到电脑上的任务说明</h2>
          <p className="muted">复制后，在自己的桌面 AI 助手中粘贴并发送。</p>
          <pre className="desktop-ai-request">{request}</pre>
          <button
            className="button quiet"
            onClick={async () => {
              setError('');
              try {
                await navigator.clipboard.writeText(request);
                setCopied(true);
              } catch {
                setError('暂时无法复制，请选中上方文字手动复制。');
              }
            }}
          >
            {copied ? <Check size={17} /> : <Copy size={17} />}
            {copied ? '已复制任务说明' : '复制任务说明'}
          </button>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <p className="muted desktop-ai-note">手机上也可以查看和复制说明，回到电脑后再操作。</p>
        </section>
      </div>
    </div>
  );
}
