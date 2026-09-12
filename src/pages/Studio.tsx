import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  Sparkles,
  Send,
  Monitor,
  Settings2,
  RefreshCw,
  Plus,
  X,
  Check,
  LoaderCircle,
  Clock3,
  Copy,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { useStore } from '../App';
import { api } from '../lib/api';
import { Modal, Empty, Busy } from '../components/common';
import GameForm from '../components/GameForm';
import { filterGames, themeInputSchema, type Job, type ThemeInput } from '../../shared/schema';

type Device = { id: string; name: string; last_seen_at: string | null };
type Event = { id: number; message: string; created_at: string };
const labels: Record<string, string> = {
  queued: '等待电脑',
  running: '正在处理',
  needs_input: '待补充',
  ready: '待保存',
  saved: '已保存',
  failed: '未完成',
  cancelled: '已取消',
};
export default function Studio() {
  const { configured, admin, login, refresh, notify } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [kind, setKind] = useState<'game' | 'theme'>(
      params.get('kind') === 'theme' ? 'theme' : 'game',
    ),
    [prompt, setPrompt] = useState(''),
    [jobs, setJobs] = useState<Job[]>([]),
    [devices, setDevices] = useState<Device[]>([]),
    [events, setEvents] = useState<Event[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [settings, setSettings] = useState(false),
    [review, setReview] = useState(false),
    [answer, setAnswer] = useState('');
  const requestRef = useRef({ prompt: '', kind: '', id: '' });
  const selected = jobs.find((j) => j.id === params.get('job'));
  const online = devices.some(
    (d) => d.last_seen_at && Date.now() - Date.parse(d.last_seen_at) < 60000,
  );
  const load = useCallback(async () => {
    if (!configured || !admin) return;
    try {
      const [j, d] = await Promise.all([api<Job[]>('/jobs'), api<Device[]>('/agents')]);
      setJobs(j);
      setDevices(d);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [configured, admin]);
  useEffect(() => {
    void load();
    if (!configured || !admin) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, configured, admin]);
  useEffect(() => {
    if (!selected) {
      setEvents([]);
      return;
    }
    void api<Event[]>(`/jobs/${selected.id}/events`)
      .then(setEvents)
      .catch(() => {});
  }, [selected?.id, selected?.updated_at]);
  const choose = (id: string) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('job', id);
      return next;
    });
    setReview(false);
    setAnswer('');
  };
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setBusy(true);
    setError('');
    try {
      if (requestRef.current.prompt !== prompt || requestRef.current.kind !== kind)
        requestRef.current = { prompt, kind, id: crypto.randomUUID() };
      const job = await api<Job>('/jobs', {
        method: 'POST',
        body: JSON.stringify({ kind, prompt, request_id: requestRef.current.id }),
      });
      await load();
      choose(job.id);
      setPrompt('');
      requestRef.current = { prompt: '', kind: '', id: '' };
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function action(action: string, body?: unknown) {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      await api(`/jobs/${selected.id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(body || {}),
      });
      await load();
      setAnswer('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (configured && !admin)
    return (
      <Empty title="你的 AI 工作台">
        <p>输入管理邀请码，让 AI 帮你记录游戏。</p>
        <button className="button primary" onClick={login}>
          输入邀请码
        </button>
      </Empty>
    );
  return (
    <>
      <Link className="back-link" to="/">
        <ArrowLeft size={17} />
        游戏库
      </Link>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR AI COMPANION</p>
          <h1>
            一句话，留下玩迹<span className="accent">。</span>
          </h1>
          <p className="muted">你来讲述，AI 整理资料。</p>
        </div>
        <button className="button quiet" onClick={() => setSettings(true)}>
          <Settings2 size={17} />
          连接电脑
        </button>
      </div>
      {!configured && (
        <div className="notice">工作台界面已就绪。连接云端并验证邀请码后，可提交真实 AI 任务。</div>
      )}
      <div className="studio-layout">
        <section className="studio-compose">
          <div className="compose-tabs">
            <button className={kind === 'game' ? 'active' : ''} onClick={() => setKind('game')}>
              <Plus size={17} />
              添加游戏
            </button>
            <button className={kind === 'theme' ? 'active' : ''} onClick={() => setKind('theme')}>
              <Sparkles size={17} />
              创建主题
            </button>
          </div>
          <form onSubmit={send}>
            <label className="prompt-label" htmlFor="ai-prompt">
              {kind === 'game' ? '想记录哪款游戏？' : '想把哪些游戏放在一起？'}
            </label>
            <textarea
              id="ai-prompt"
              rows={7}
              maxLength={4000}
              placeholder={
                kind === 'game'
                  ? '例如：添加《空洞骑士》，Steam 上玩了 40 小时，2026 年通关。'
                  : '例如：把我玩过的轨迹系列按年份做成时间线，再展示游玩平台分布。'
              }
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <div className="prompt-footer">
              <span className="muted">{prompt.length} / 4000</span>
              <button
                className="button primary"
                disabled={!configured || !admin || busy || prompt.trim().length < 2}
              >
                {busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}开始整理
              </button>
            </div>
          </form>
          <div className="ai-explainer">
            <Sparkles size={18} />
            <p>
              {kind === 'game'
                ? 'AI 会搜索发行信息、开发商、类型和评分，自动保存封面与截图。你的游玩记录可以在保存前补充。'
                : 'AI 会将你的描述转换成游戏筛选条件、图表和布局。主题保存后会随游戏记录自动更新。'}
            </p>
          </div>
          <div className={`device-state ${online ? 'online' : ''}`}>
            <Monitor size={17} />
            <span>
              {online ? '电脑已连接' : '电脑未连接'}
              <small>{online ? '可以接收 AI 任务' : '任务会在电脑上线后开始'}</small>
            </span>
            {configured && (
              <button className="icon-button" aria-label="刷新连接状态" onClick={() => void load()}>
                <RefreshCw size={16} />
              </button>
            )}
          </div>
          <div className="job-history">
            <h3>最近的任务</h3>
            {jobs.length ? (
              jobs.map((j) => (
                <button
                  key={j.id}
                  className={j.id === selected?.id ? 'active' : ''}
                  onClick={() => choose(j.id)}
                >
                  <span>{j.prompt.slice(0, 60)}</span>
                  <small>{labels[j.status]}</small>
                </button>
              ))
            ) : (
              <p className="muted">完成的任务会保留在这里。</p>
            )}
          </div>
        </section>
        <section className="studio-result" aria-live="polite">
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          {!selected ? (
            <div className="ai-empty">
              <span className="ai-symbol">
                <Sparkles size={36} />
              </span>
              <h2>下一段冒险，从这里开始</h2>
              <p>
                输入游戏名称和你想记录的内容，
                <br />
                查询进度与结果会出现在这里。
              </p>
              <div className="flow-hint">
                <span>识别游戏</span>
                <span>搜集资料</span>
                <span>补充记录</span>
                <span>保存</span>
              </div>
            </div>
          ) : (
            <>
              <div className="result-header">
                <span className="eyebrow">
                  {selected.kind === 'game' ? 'GAME RESEARCH' : 'COLLECTION DESIGN'}
                </span>
                <span className={`pill ${selected.status === 'running' ? 'active' : ''}`}>
                  {labels[selected.status]}
                </span>
              </div>
              <h2 className="job-prompt">{selected.prompt.split('\n')[0]}</h2>
              <div className="job-progress">
                {['queued', 'running'].includes(selected.status) ? (
                  <LoaderCircle size={22} className="spin" />
                ) : selected.status === 'failed' ? (
                  <X size={22} />
                ) : (
                  <Check size={22} />
                )}
                <span>{selected.progress}</span>
              </div>
              {selected.status === 'queued' && !online && (
                <p className="notice">
                  请保持电脑上的 Playtrace 连接服务运行。连接成功后，任务会自动开始。
                </p>
              )}
              {events.length > 0 && (
                <ol className="event-list">
                  {events.map((e) => (
                    <li key={e.id}>
                      <span>{e.message}</span>
                      <time>
                        {new Date(e.created_at).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </time>
                    </li>
                  ))}
                </ol>
              )}
              {selected.status === 'failed' && (
                <p className="error-message">
                  {selected.error || '任务没有完成，可以检查连接后重试。'}
                </p>
              )}
              {selected.status === 'needs_input' && (
                <form
                  className="clarification"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void action('answer', { answer });
                  }}
                >
                  <h3>需要你补充一点信息</h3>
                  <p>{selected.result?.question}</p>
                  <textarea
                    rows={3}
                    required
                    maxLength={1500}
                    placeholder="在这里回答…"
                    value={answer}
                    onChange={(e) => setAnswer(e.target.value)}
                  />
                  <button className="button primary" disabled={busy || !answer.trim()}>
                    <Send size={16} />
                    继续整理
                  </button>
                </form>
              )}
              {selected.status === 'ready' && (
                <div className="draft-summary">
                  <p className="eyebrow">READY TO SAVE</p>
                  <h2>{selected.result?.game?.title || selected.result?.theme?.title}</h2>
                  <p className="muted">
                    {selected.kind === 'game'
                      ? `${selected.result?.game?.developer || '开发商待补充'} · ${selected.result?.game?.release_year || '发行年份待补充'}`
                      : selected.result?.theme?.description}
                  </p>
                  {selected.result?.game && (
                    <div className="draft-tags">
                      {selected.result.game.tags.map((t) => (
                        <span className="pill" key={t}>
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  <button className="button primary" onClick={() => setReview(true)}>
                    <Check size={18} />
                    {selected.kind === 'game' ? '检查资料并补充游玩记录' : '预览并保存主题'}
                  </button>
                </div>
              )}
              {selected.status === 'saved' && (
                <div className="success-result">
                  <Check size={28} />
                  <h3>已加入你的玩迹</h3>
                  <Link className="button quiet" to={selected.kind === 'game' ? '/' : '/themes'}>
                    查看{selected.kind === 'game' ? '游戏库' : '主题收藏'}
                  </Link>
                </div>
              )}
              <div className="job-actions">
                {['failed', 'cancelled'].includes(selected.status) && (
                  <button
                    className="button quiet"
                    disabled={busy}
                    onClick={() => void action('retry')}
                  >
                    <RefreshCw size={16} />
                    重新尝试
                  </button>
                )}
                {['queued', 'running', 'needs_input', 'ready'].includes(selected.status) && (
                  <button
                    className="button quiet small"
                    disabled={busy}
                    onClick={() => void action('cancel')}
                  >
                    取消任务
                  </button>
                )}
                <span className="muted">刷新或离开页面，记录都会保留。</span>
              </div>
            </>
          )}
        </section>
      </div>
      {settings && (
        <DeviceSettings
          configured={configured && admin}
          devices={devices}
          onClose={() => setSettings(false)}
          onChange={load}
        />
      )}
      {review && selected?.result && (
        <Modal
          title={selected.kind === 'game' ? '检查游戏资料' : '保存主题收藏'}
          onClose={() => setReview(false)}
          wide
        >
          {selected.kind === 'game' && selected.result.game ? (
            <GameForm
              initial={selected.result.game}
              onSave={async (data) => {
                const saved = await api<{ id: string }>(`/jobs/${selected.id}/save`, {
                  method: 'POST',
                  body: JSON.stringify(data),
                });
                await refresh();
                notify('游戏已加入玩迹');
                setReview(false);
                navigate(`/games/${saved.id}`);
              }}
            />
          ) : selected.result.theme ? (
            <ThemeReview
              initial={selected.result.theme}
              onSave={async (data) => {
                const saved = await api<{ id: string }>(`/jobs/${selected.id}/save`, {
                  method: 'POST',
                  body: JSON.stringify(data),
                });
                await refresh();
                notify('主题已创建');
                setReview(false);
                navigate(`/themes/${saved.id}`);
              }}
            />
          ) : null}
        </Modal>
      )}
    </>
  );
}
function DeviceSettings({
  configured,
  devices,
  onClose,
  onChange,
}: {
  configured: boolean;
  devices: Device[];
  onClose: () => void;
  onChange: () => Promise<void>;
}) {
  const [name, setName] = useState('我的电脑'),
    [token, setToken] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  return (
    <Modal title="连接本机 Codex" onClose={onClose}>
      <div className="device-setup">
        <p className="muted">
          在你的电脑启动 Playtrace 连接服务，网页就能把任务交给
          Codex。只需配置一次，之后在网页里操作。
        </p>
        <ol>
          <li>为这台电脑创建连接密钥。</li>
          <li>将网站地址和密钥填入电脑上的连接配置。</li>
          <li>启动连接服务，并保持 Codex 已登录。</li>
        </ol>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              const data = await api<{ token: string }>('/agents', {
                method: 'POST',
                body: JSON.stringify({ name }),
              });
              setToken(data.token);
              setCopied(false);
              await onChange();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            电脑名称
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="button primary" disabled={!configured || busy}>
            <Plus size={16} />
            创建连接密钥
          </button>
        </form>
        {token && (
          <div className="token-box">
            <p>请保存这个密钥，它只会显示一次。</p>
            <code>{token}</code>
            <button
              className="button quiet small"
              onClick={() =>
                void navigator.clipboard
                  .writeText(token)
                  .then(() => setCopied(true))
                  .catch(() => setError('无法自动复制，请手动选择密钥复制'))
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? '已复制' : '复制密钥'}
            </button>
          </div>
        )}
        {error && <p className="error-message">{error}</p>}
        <div className="device-list">
          {devices.map((d) => (
            <div key={d.id}>
              <Monitor size={20} />
              <span>
                {d.name}
                <small>
                  {d.last_seen_at
                    ? `最后连接 ${new Date(d.last_seen_at).toLocaleString('zh-CN')}`
                    : '尚未连接'}
                </small>
              </span>
              <button
                className="button quiet small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/agents/${d.id}`, { method: 'DELETE' });
                    await onChange();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                断开
              </button>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
function ThemeReview({
  initial,
  onSave,
}: {
  initial: ThemeInput;
  onSave: (data: ThemeInput) => Promise<void>;
}) {
  const { games } = useStore();
  const [form, setForm] = useState(initial),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const matches = filterGames(games, form.filters);
  return (
    <form
      className="theme-review"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        try {
          await onSave(themeInputSchema.parse(form));
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <label className="span-2">
          主题名称
          <input
            required
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </label>
        <label className="span-2">
          主题介绍
          <textarea
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </label>
        <label>
          布局
          <select
            value={form.layout}
            onChange={(e) => setForm({ ...form, layout: e.target.value as ThemeInput['layout'] })}
          >
            <option value="gallery">游戏画廊</option>
            <option value="timeline">年份时间线</option>
          </select>
        </label>
        <label>
          统计图表
          <select
            value={form.chart}
            onChange={(e) => setForm({ ...form, chart: e.target.value as ThemeInput['chart'] })}
          >
            <option value="platform">平台分布</option>
            <option value="genre">类型分布</option>
            <option value="year">游玩年份</option>
            <option value="developer">开发商</option>
          </select>
        </label>
        <label>
          排序
          <select
            value={form.sort}
            onChange={(e) => setForm({ ...form, sort: e.target.value as ThemeInput['sort'] })}
          >
            <option value="recent">最近游玩</option>
            <option value="hours">累计时长</option>
            <option value="title">游戏名称</option>
            <option value="rating">我的评分</option>
          </select>
        </label>
        <label>
          可见范围
          <select
            value={form.is_published ? 'public' : 'private'}
            onChange={(e) => setForm({ ...form, is_published: e.target.value === 'public' })}
          >
            <option value="public">公开</option>
            <option value="private">仅自己可见</option>
          </select>
        </label>
      </div>
      <div className="filter-review">
        <h3>筛选条件</h3>
        {Object.entries(form.filters)
          .filter(([, v]) => v.length)
          .map(([k, v]) => (
            <p key={k}>
              <span>
                {
                  {
                    tags: '类型',
                    platforms: '平台',
                    statuses: '状态',
                    years: '年份',
                    developers: '开发商',
                    series: '系列',
                    title_keywords: '名称关键词',
                  }[k]
                }
              </span>
              {v.join('、')}
            </p>
          ))}
        <p className="notice">
          当前匹配 {matches.length} 款游戏。新增符合条件的游戏后，会自动加入主题。
        </p>
        <div className="matched-games">
          {matches.slice(0, 15).map((g) => (
            <span key={g.id}>{g.title}</span>
          ))}
          {matches.length > 15 && <span>及其他 {matches.length - 15} 款</span>}
        </div>
      </div>
      {error && <p className="error-message">{error}</p>}
      <div className="form-actions">
        <button className="button primary" disabled={busy}>
          <Check size={18} />
          保存主题
        </button>
      </div>
    </form>
  );
}
