import { searchLibrary } from '../shared/library';
import { useLibraryTools } from './lib/library-tools';
import themeDefaults from '../shared/default-themes.json';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import {
  Routes,
  Route,
  Link,
  NavLink,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  Search,
  Library,
  ChartNoAxesCombined,
  Sparkles,
  ArrowUpRight,
  Plus,
  SlidersHorizontal,
  ArrowLeft,
  Pencil,
  Trash2,
  Clock3,
  CalendarDays,
  ExternalLink,
  LogIn,
  LogOut,
  X,
  LayoutGrid,
  List,
  Gamepad2,
  Check,
  Settings2,
  LoaderCircle,
} from 'lucide-react';
import { api, configure, loadSeedGames, enterManagement, leaveManagement } from './lib/api';
import {
  filterGames,
  sortGames,
  summarize,
  themeInputSchema,
  type Game,
  type GameInput,
  type Theme,
} from '../shared/schema';
import { GameCard, Cover, Badge, Modal, Empty, Busy, Bars } from './components/common';
const GameForm = lazy(() => import('./components/GameForm'));
const Studio = lazy(() => import('./pages/Studio'));

const defaultThemes: Theme[] = themeDefaults.map((t) => ({
  ...themeInputSchema.parse(t),
  id: t.id,
  version: t.version,
}));
type Store = {
  games: Game[];
  themes: Theme[];
  configured: boolean;
  admin: boolean;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  login: () => void;
};
const Context = createContext<Store>(null!);
export const useStore = () => useContext(Context);
export default function App() {
  const [games, setGames] = useState<Game[]>([]),
    [themes, setThemes] = useState<Theme[]>([]),
    [configured, setConfigured] = useState(false),
    [admin, setAdmin] = useState(false),
    [accountEmail, setAccountEmail] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [login, setLogin] = useState(false),
    [toast, setToast] = useState('');
  const refresh = useCallback(async () => {
    const [gs, ts, me] = await Promise.all([
      api<Game[]>('/games'),
      api<Theme[]>('/themes'),
      api<{ admin: boolean; email: string | null }>('/me').catch(() => ({
        admin: false,
        email: null,
      })),
    ]);
    setGames(gs);
    setThemes(ts);
    setAdmin(me.admin);
    setAccountEmail(me.email);
    setError('');
  }, []);
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      try {
        const ready = await configure();
        if (!active) return;
        setConfigured(ready);
        if (ready) {
          await refresh();
          if (!active) return;
          const refreshVisible = () => {
            if (document.visibilityState === 'visible') void refresh().catch(() => {});
          };
          const imageRefresh = setInterval(refreshVisible, 600000);
          document.addEventListener('visibilitychange', refreshVisible);
          window.addEventListener('playtrace:access', refreshVisible);
          const channel =
            typeof BroadcastChannel !== 'undefined'
              ? new BroadcastChannel('playtrace-access')
              : null;
          if (channel) channel.onmessage = refreshVisible;
          unsubscribe = () => {
            clearInterval(imageRefresh);
            document.removeEventListener('visibilitychange', refreshVisible);
            window.removeEventListener('playtrace:access', refreshVisible);
            channel?.close();
          };
        } else {
          setGames(await loadSeedGames());
          setThemes(import.meta.env.DEV ? defaultThemes : []);
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <Context.Provider
      value={{
        games,
        themes,
        configured,
        admin,
        refresh,
        notify: setToast,
        login: () => setLogin(true),
      }}
    >
      <div className="app-shell">
        <header className="site-header">
          <Link className="brand" to="/">
            <span className="brand-mark">P</span>
            <span>Playtrace</span>
            <span className="brand-caption">玩迹</span>
          </Link>
          <nav aria-label="主导航">
            <NavLink to="/" end>
              <Library size={17} />
              游戏库
            </NavLink>
            <NavLink to="/insights">
              <ChartNoAxesCombined size={17} />
              游戏足迹
            </NavLink>
            <NavLink to="/themes">
              <Sparkles size={17} />
              主题收藏
            </NavLink>
          </nav>
          {admin ? (
            <div className="header-actions">
              <Link className="button quiet" to="/studio">
                <Sparkles size={16} />
                桌面 AI 指南
              </Link>
              <button
                className="icon-button"
                title={accountEmail ? `${accountEmail} · 退出登录` : '退出登录'}
                aria-label="退出登录"
                onClick={() =>
                  void leaveManagement()
                    .then(refresh)
                    .catch((e) => setToast(e.message))
                }
              >
                <LogOut size={17} />
              </button>
            </div>
          ) : (
            <button className="button quiet" onClick={() => setLogin(true)}>
              管理档案
              <ArrowUpRight size={16} />
            </button>
          )}
        </header>
        <main>
          {loading ? (
            <Busy />
          ) : error ? (
            <Empty title="暂时无法读取档案">
              <p>{error}</p>
              <button className="button quiet" onClick={() => location.reload()}>
                重新连接
              </button>
            </Empty>
          ) : (
            <Suspense fallback={<Busy />}>
              <Routes>
                <Route path="/" element={<LibraryPage />} />
                <Route path="/games/new" element={<EditorPage />} />
                <Route path="/games/:id/edit" element={<EditorPage />} />
                <Route path="/games/:id" element={<DetailPage />} />
                <Route path="/insights" element={<InsightsPage />} />
                <Route path="/themes" element={<ThemesPage />} />
                <Route path="/themes/:id" element={<ThemePage />} />
                <Route path="/studio" element={<Studio />} />
                <Route
                  path="*"
                  element={
                    <Empty title="这一页还没有存档">
                      <Link to="/">回到游戏库</Link>
                    </Empty>
                  }
                />
              </Routes>
            </Suspense>
          )}
          <footer>
            <span>
              PLAYTRACE <span className="footer-year"> / 玩迹</span>
            </span>
            <span>{!configured ? '本地数据预览' : '记录热爱，慢慢通关。'}</span>
          </footer>
        </main>
        {toast && (
          <div className="toast" role="status">
            <Check size={18} />
            {toast}
            <button className="icon-button" aria-label="关闭提示" onClick={() => setToast('')}>
              <X size={16} />
            </button>
          </div>
        )}
        {login && <GoogleLoginModal onClose={() => setLogin(false)} />}
      </div>
    </Context.Provider>
  );
}
function GoogleLoginModal({ onClose }: { onClose: () => void }) {
  const { configured, refresh, notify } = useStore();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="登录玩迹" onClose={onClose}>
      {configured ? (
        <form
          className="login-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              await enterManagement();
              await refresh();
              notify('已使用 Google 账号登录');
              onClose();
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <p className="muted">使用已授权的 Google 账号，管理游戏记录、图片和主题。</p>
          {error && (
            <p role="alert" className="error-message">
              {error}
            </p>
          )}
          <button disabled={busy} className="button primary" type="submit">
            {busy ? <LoaderCircle size={18} className="spin" /> : <LogIn size={18} />}
            {busy ? '正在等待 Google 登录…' : '使用 Google 账号登录'}
          </button>
          <p className="muted">公开游戏无需登录即可浏览。登录状态最长保留 7 天。</p>
        </form>
      ) : (
        <div className="setup-message">
          <p>当前是本地预览。连接云端并配置 Google 登录后，即可保存和管理游戏。</p>
        </div>
      )}
    </Modal>
  );
}
function PageHeading({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>
          {title}
          <span className="accent">。</span>
        </h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}
function LibraryPage() {
  const { games, admin, configured, login } = useStore();
  const [params, setParams] = useSearchParams();
  const [filters, setFilters] = useState(false),
    [view, setView] = useState('grid');
  const query = params.get('q') || '',
    status = params.get('status') || '',
    platform = params.get('platform') || '',
    year = params.get('year') || '',
    tag = params.get('tag') || '',
    developer = params.get('developer') || '',
    sort = params.get('sort') || 'recent';
  const set = (key: string, value: string) => {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (value) n.set(key, value);
        else n.delete(key);
        return n;
      },
      { replace: true },
    );
  };
  useLibraryTools(games, setParams);
  const visible = searchLibrary(games, params);
  const stats = summarize(games);
  const hasFilter = !!(query || status || platform || year || tag || developer);
  return (
    <>
      <PageHeading
        eyebrow="THE COLLECTION"
        title="走过的世界"
        description="每一次出发，都值得被记住。"
      >
        {admin || !configured ? (
          <Link className="button primary" to="/games/new">
            <Plus size={18} />
            添加游戏
          </Link>
        ) : (
          <button className="button quiet" onClick={login}>
            <Plus size={18} />
            添加游戏
          </button>
        )}
      </PageHeading>
      <div className="library-summary">
        <span>
          <strong>{stats.count}</strong> 款游戏
        </span>
        <span>
          <strong>{stats.completed}</strong> 已完成
        </span>
        <span>
          <strong>{stats.playing}</strong> 进行中
        </span>
        <span className="summary-period">
          {Math.min(...games.flatMap((g) => g.played_years).concat(new Date().getFullYear()))} —{' '}
          {new Date().getFullYear()}
        </span>
      </div>
      <div className="toolbar">
        <label className="search-box">
          <Search size={18} />
          <input
            aria-label="搜索游戏"
            placeholder="搜索游戏名称、开发商…"
            value={query}
            onChange={(e) => set('q', e.target.value)}
          />
          {query && (
            <button className="icon-button" aria-label="清除搜索" onClick={() => set('q', '')}>
              <X size={15} />
            </button>
          )}
        </label>
        <div className="status-tabs">
          {[
            ['', '全部'],
            ['进行中', '进行中'],
            ['完成', '已完成'],
            ['暂停', '暂停'],
            ['中断', '中断'],
          ].map(([s, label]) => (
            <button
              key={s}
              className={status === s ? 'selected' : ''}
              onClick={() => set('status', s)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className={`button quiet filter-toggle ${filters || platform || year || tag || developer ? 'selected' : ''}`}
          aria-expanded={filters}
          onClick={() => setFilters(!filters)}
        >
          <SlidersHorizontal size={16} />
          筛选
        </button>
      </div>
      {(filters || platform || year || tag || developer) && (
        <div className="filter-panel">
          <select
            aria-label="筛选平台"
            value={platform}
            onChange={(e) => set('platform', e.target.value)}
          >
            <option value="">全部平台</option>
            {[...new Set(games.map((g) => g.platform).filter(Boolean))].sort().map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <select aria-label="筛选年份" value={year} onChange={(e) => set('year', e.target.value)}>
            <option value="">全部年份</option>
            {[...new Set(games.flatMap((g) => g.played_years))]
              .sort((a, b) => b - a)
              .map((y) => (
                <option key={y}>{y}</option>
              ))}
          </select>
          <select aria-label="筛选类型" value={tag} onChange={(e) => set('tag', e.target.value)}>
            <option value="">全部类型</option>
            {[...new Set(games.flatMap((g) => g.tags))].sort().map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select
            aria-label="筛选开发商"
            value={developer}
            onChange={(e) => set('developer', e.target.value)}
          >
            <option value="">全部开发商</option>
            {[...new Set(games.map((g) => g.developer).filter(Boolean))].sort().map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
          <button className="button quiet small" onClick={() => setParams({})}>
            重置
          </button>
        </div>
      )}
      <div className="results-heading">
        <span className="muted">
          {hasFilter ? '筛选结果' : '全部游戏'} <strong>{visible.length}</strong>
        </span>
        <div className="result-controls">
          <select
            aria-label="排序"
            className="sort-select"
            value={sort}
            onChange={(e) => set('sort', e.target.value)}
          >
            <option value="recent">最近游玩</option>
            <option value="hours">游玩时长</option>
            <option value="title">游戏名称</option>
            <option value="rating">我的评分</option>
          </select>
          <div className="view-switch">
            <button
              className={view === 'grid' ? 'active' : ''}
              aria-label="卡片视图"
              onClick={() => setView('grid')}
            >
              <LayoutGrid size={17} />
            </button>
            <button
              className={view === 'list' ? 'active' : ''}
              aria-label="列表视图"
              onClick={() => setView('list')}
            >
              <List size={19} />
            </button>
          </div>
        </div>
      </div>
      {visible.length ? (
        <div className={view === 'grid' ? 'game-grid' : 'game-list'}>
          {visible.map((g) => (
            <GameCard game={g} key={g.id} />
          ))}
        </div>
      ) : (
        <Empty title="没有找到这样的游戏">
          <button className="button quiet" onClick={() => setParams({})}>
            清除筛选
          </button>
        </Empty>
      )}
    </>
  );
}
function DetailPage() {
  const { id } = useParams();
  const { games, admin, refresh, notify } = useStore();
  const navigate = useNavigate();
  const [image, setImage] = useState<number | null>(null),
    [remove, setRemove] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const g = games.find((g) => g.id === id);
  useEffect(() => {
    if (g) document.title = `${g.title} · 玩迹 Playtrace`;
    return () => {
      document.title = '玩迹 Playtrace · 游戏档案';
    };
  }, [g]);
  if (!g)
    return (
      <Empty title="没有找到这款游戏">
        <Link to="/">返回游戏库</Link>
      </Empty>
    );
  return (
    <>
      <div className="detail-toolbar">
        <Link className="back-link" to="/">
          <ArrowLeft size={17} />
          游戏库
        </Link>
        {admin && (
          <div className="header-actions">
            <Link className="button quiet small" to={`/studio?game=${g.id}`}>
              <Sparkles size={15} />
              桌面 AI 补全
            </Link>
            <Link className="button quiet small" to={`/games/${g.id}/edit`}>
              <Pencil size={15} />
              编辑
            </Link>
            <button className="icon-button" aria-label="删除游戏" onClick={() => setRemove(true)}>
              <Trash2 size={17} />
            </button>
          </div>
        )}
      </div>
      <section className="detail-hero">
        <Cover game={g} />
        <div className="detail-shade" />
        <div className="detail-heading">
          <p className="eyebrow">{g.developer || 'MY GAME ARCHIVE'}</p>
          <h1>{g.title}</h1>
          <p className="english-title">{g.english_title}</p>
          <div className="detail-tags">
            <Badge status={g.status} />
            {g.tags.map((t) => (
              <Link key={t} to={`/?tag=${encodeURIComponent(t)}`}>
                {t}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="detail-layout">
        <div>
          <section className="panel">
            <div className="section-title">
              <h2>我的游玩记录</h2>
              {!g.is_published && <span className="pill">仅自己可见</span>}
            </div>
            <div className="play-stats">
              <div>
                <Clock3 size={19} />
                <strong>
                  {g.hours ?? '—'}
                  <small>{g.hours !== null ? '小时' : '未记录'}</small>
                </strong>
                <span>累计游玩</span>
              </div>
              <div>
                <CalendarDays size={19} />
                <strong>{g.played_years.join(' / ') || '—'}</strong>
                <span>游玩年份</span>
              </div>
              <div>
                <Gamepad2 size={19} />
                <strong>{g.platform || '—'}</strong>
                <span>游玩平台</span>
              </div>
            </div>
            {g.personal_rating !== null && (
              <div className="personal-score">
                我的评分 <strong>{g.personal_rating}</strong>
                <span>/ 10</span>
              </div>
            )}
            {g.notes ? (
              <div className="notes-text">{g.notes}</div>
            ) : (
              <p className="quiet-note">
                {admin ? '这一段冒险，还没有写下感想。' : '把这段冒险，留在记忆里。'}
              </p>
            )}
          </section>
          {g.images.length > 1 && (
            <section className="screenshots">
              <div className="section-title">
                <h2>世界一瞥</h2>
                <span className="muted">{g.images.length} 张图片</span>
              </div>
              <div className="screenshot-grid">
                {g.images.map((_, i) => (
                  <button key={i} aria-label={`查看图片 ${i + 1}`} onClick={() => setImage(i)}>
                    <Cover game={g} index={i} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside>
          <section className="panel">
            <h3>关于这款游戏</h3>
            <dl className="metadata">
              <dt>开发商</dt>
              <dd>
                <Link to={`/?developer=${encodeURIComponent(g.developer)}`}>
                  {g.developer || '未记录'}
                </Link>
              </dd>
              <dt>发行年份</dt>
              <dd>{g.release_year ? `${g.release_year} 年` : '未记录'}</dd>
              {g.series && (
                <>
                  <dt>游戏系列</dt>
                  <dd>{g.series}</dd>
                </>
              )}
              {g.japanese_title && (
                <>
                  <dt>日文名称</dt>
                  <dd>{g.japanese_title}</dd>
                </>
              )}
            </dl>
            {g.wikipedia_url && (
              <a className="external-link" href={g.wikipedia_url} target="_blank" rel="noreferrer">
                Wikipedia <ExternalLink size={14} />
              </a>
            )}
          </section>
          <section className="panel">
            <div className="section-title">
              <h3>Metacritic</h3>
              <span className="muted">媒体评分</span>
            </div>
            {g.mc_scores.length ? (
              <div className="mc-scores">
                {g.mc_scores.map((mc, i) => (
                  <div key={i}>
                    <span
                      className={`mc-number ${mc.score >= 75 ? 'good' : mc.score >= 50 ? 'mixed' : 'low'}`}
                    >
                      {mc.score}
                    </span>
                    <span>{mc.platform}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">暂未收录评分</p>
            )}
            <p className="data-note">各平台分别计分 · 满分 100</p>
          </section>
        </aside>
      </div>
      {image !== null && (
        <Modal
          title={`${g.title} · ${image + 1} / ${g.images.length}`}
          onClose={() => setImage(null)}
          wide
        >
          <div className="lightbox">
            <Cover game={g} index={image} />
          </div>
          <div className="lightbox-controls">
            <button
              className="button quiet"
              disabled={image === 0}
              onClick={() => setImage(image - 1)}
            >
              上一张
            </button>
            <button
              className="button quiet"
              disabled={image === g.images.length - 1}
              onClick={() => setImage(image + 1)}
            >
              下一张
            </button>
          </div>
        </Modal>
      )}
      {remove && (
        <Modal title="删除这款游戏？" onClose={() => setRemove(false)}>
          <p className="modal-copy">
            「{g.title}」将从游戏库和相关统计中移除。后台会保留存档，便于恢复。
          </p>
          {error && <p className="error-message">{error}</p>}
          <div className="modal-actions">
            <button className="button quiet" onClick={() => setRemove(false)}>
              保留
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/games/${g.id}?version=${g.version}`, { method: 'DELETE' });
                  await refresh();
                  notify('游戏已移除');
                  navigate('/');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除游戏
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function EditorPage() {
  const { id } = useParams();
  const { games, admin, configured, refresh, notify, login } = useStore();
  const navigate = useNavigate();
  const g = games.find((g) => g.id === id);
  if (configured && !admin)
    return (
      <Empty title="登录后管理游戏">
        <button className="button primary" onClick={login}>
          Google 账号登录
        </button>
      </Empty>
    );
  if (id && !g) return <Empty title="游戏不存在" />;
  return (
    <div className="editor-page">
      <Link className="back-link" to={g ? `/games/${g.id}` : '/'}>
        <ArrowLeft size={17} />
        返回
      </Link>
      <PageHeading
        eyebrow={id ? 'EDIT YOUR MEMORY' : 'A NEW ADVENTURE'}
        title={id ? '编辑游戏' : '添加一段冒险'}
      >
        {!id && (
          <Link className="button primary" to="/studio">
            <Sparkles size={17} />
            在电脑上用 AI 整理
          </Link>
        )}
      </PageHeading>
      <GameForm
        initial={g || { title: '' }}
        configured={configured && admin}
        onSave={async (data) => {
          const saved = await api<Game>(id ? `/games/${id}` : '/games', {
            method: id ? 'PUT' : 'POST',
            body: JSON.stringify({ ...data, ...(g ? { version: g.version } : {}) }),
          });
          await refresh();
          notify(id ? '修改已保存' : '游戏已加入玩迹');
          navigate(`/games/${saved.id}`);
        }}
      />
    </div>
  );
}
function InsightsPage() {
  const { games } = useStore();
  const [year, setYear] = useState('');
  const navigate = useNavigate();
  const subset = year ? games.filter((g) => g.played_years.includes(Number(year))) : games;
  const stats = summarize(subset);
  const top = sortGames(
    subset.filter((g) => g.hours !== null),
    'hours',
  ).slice(0, 6);
  return (
    <>
      <PageHeading
        eyebrow="YOUR PLAYING STORY"
        title="时间留下的足迹"
        description="回看走过的世界，也发现自己的偏爱。"
      >
        <select aria-label="统计年份" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">所有年份</option>
          {[...new Set(games.flatMap((g) => g.played_years))]
            .sort((a, b) => b - a)
            .map((y) => (
              <option key={y}>{y}</option>
            ))}
        </select>
      </PageHeading>
      <div className="stat-grid">
        <Stat label={year ? '这一年玩过' : '游戏收藏'} value={stats.count} unit="款" />
        <Stat label="当前已完成" value={stats.completed} unit="款" />
        <Stat
          label={year ? '这些游戏的累计时长' : '已记录总时长'}
          value={stats.hours.toLocaleString()}
          unit="小时"
        />
        <Stat
          label="时长记录覆盖"
          value={stats.count ? Math.round((stats.recorded / stats.count) * 100) : 0}
          unit="%"
        />
      </div>
      <p className="data-note stats-note">
        {year
          ? '跨年游戏的时长是累计值，不代表该年的实际游玩时长。'
          : '未记录时长的游戏不计入小时数。'}{' '}
        完成状态为当前状态，游玩年份不等同于通关年份。
      </p>
      <div className="insights-grid">
        <section className="panel">
          <div className="section-title">
            <h2>游玩年份</h2>
            <span className="muted">每年玩过的游戏数量</span>
          </div>
          <Bars games={games} by="year" limit={100} onPick={(label) => setYear(label)} />
          <p className="data-note">跨年游玩的游戏会出现在多个年份中。</p>
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>在哪儿冒险</h2>
            <span className="muted">游玩平台</span>
          </div>
          <Bars
            games={subset}
            by="platform"
            onPick={(label) =>
              navigate(`/?platform=${encodeURIComponent(label)}${year ? `&year=${year}` : ''}`)
            }
          />
          <p className="data-note">保留原始平台分类，Steam 与 PC 分别展示。</p>
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>偏爱的类型</h2>
            <span className="muted">游戏标签</span>
          </div>
          <Bars
            games={subset}
            by="genre"
            onPick={(label) =>
              navigate(`/?tag=${encodeURIComponent(label)}${year ? `&year=${year}` : ''}`)
            }
          />
          <p className="data-note">一款游戏可能属于多个类型。</p>
        </section>
        <section className="panel">
          <div className="section-title">
            <h2>投入最多的世界</h2>
            <span className="muted">累计游玩时长</span>
          </div>
          <div className="time-ranking">
            {top.map((g, i) => (
              <Link to={`/games/${g.id}`} key={g.id}>
                <span className="rank-index">{String(i + 1).padStart(2, '0')}</span>
                <div className="rank-cover">
                  <Cover game={g} />
                </div>
                <span>
                  {g.title}
                  <small>{g.platform}</small>
                </span>
                <strong>
                  {g.hours}
                  <small>h</small>
                </strong>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
function Stat({ label, value, unit }: { label: string; value: number | string; unit: string }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>
        {value}
        <small>{unit}</small>
      </strong>
    </div>
  );
}
function ThemesPage() {
  const { games, themes, admin, configured } = useStore();
  return (
    <>
      <PageHeading
        eyebrow="CURATED COLLECTIONS"
        title="把热爱放在一起"
        description="一个系列，一种偏爱，一段共同的回忆。"
      >
        {(admin || !configured) && (
          <Link className="button primary" to="/studio?kind=theme">
            <Sparkles size={17} />
            桌面 AI 指南
          </Link>
        )}
      </PageHeading>
      <div className="themes-grid">
        {themes.map((theme, i) => {
          const gs = filterGames(games, theme.filters);
          const cover = gs.find((g) => g.images.length);
          return (
            <Link className="theme-card" to={`/themes/${theme.id}`} key={theme.id}>
              {cover && <Cover game={cover} />}
              <div className="theme-gradient" />
              <div className="theme-content">
                <span className="theme-index">COLLECTION {String(i + 1).padStart(2, '0')}</span>
                <h2>{theme.title}</h2>
                <p>{theme.description}</p>
                <div>
                  <span>
                    {gs.length} 款游戏{!theme.is_published ? ' · 私密' : ''}
                  </span>
                  <ArrowUpRight size={22} />
                </div>
              </div>
            </Link>
          );
        })}
      </div>
      {themes.length === 0 && (
        <Empty title="主题收藏还在等待第一段故事">
          <p>可以在电脑端借助 AI 规划游戏专题。</p>
        </Empty>
      )}
    </>
  );
}
function ThemePage() {
  const { id } = useParams();
  const { games, themes, admin, refresh, notify } = useStore();
  const navigate = useNavigate();
  const theme = themes.find((t) => t.id === id);
  const [confirm, setConfirm] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  if (!theme) return <Empty title="主题不存在" />;
  const gs = sortGames(filterGames(games, theme.filters), theme.sort);
  const years = [...new Set(gs.flatMap((g) => g.played_years))].sort((a, b) => b - a);
  return (
    <>
      <Link className="back-link" to="/themes">
        <ArrowLeft size={17} />
        主题收藏
      </Link>
      <PageHeading
        eyebrow="A COLLECTION OF MEMORIES"
        title={theme.title}
        description={theme.description}
      >
        {admin && (
          <button className="button quiet" onClick={() => setConfirm(true)}>
            <Trash2 size={16} />
            删除主题
          </button>
        )}
      </PageHeading>
      <div className="theme-detail-summary">
        <span className="pill">{gs.length} 款游戏</span>
        <span className="muted">随游戏记录自动更新</span>
      </div>
      <section className="panel theme-chart">
        <Bars games={gs} by={theme.chart} />
      </section>
      {theme.layout === 'timeline' ? (
        years.map((y) => (
          <section className="timeline-section" key={y}>
            <h2>
              {y}
              <span>{gs.filter((g) => g.played_years.includes(y)).length} 款游戏</span>
            </h2>
            <div className="game-grid">
              {gs
                .filter((g) => g.played_years.includes(y))
                .map((g) => (
                  <GameCard game={g} key={g.id} />
                ))}
            </div>
          </section>
        ))
      ) : (
        <div className="game-grid">
          {gs.map((g) => (
            <GameCard game={g} key={g.id} />
          ))}
        </div>
      )}
      {!gs.length && <Empty title="还没有符合这个主题的游戏" />}
      {confirm && (
        <Modal title="删除这个主题？" onClose={() => setConfirm(false)}>
          <p className="modal-copy">只移除主题页面，游戏记录会保留。</p>
          {error && <p className="error-message">{error}</p>}
          <div className="modal-actions">
            <button className="button quiet" onClick={() => setConfirm(false)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/themes/${theme.id}?version=${theme.version}`, { method: 'DELETE' });
                  await refresh();
                  notify('主题已删除');
                  navigate('/themes');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              删除主题
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
