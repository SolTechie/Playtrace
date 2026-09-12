import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Gamepad2, X, ArrowUpRight, LoaderCircle } from 'lucide-react';
import { groupGames, type Game, type ThemeInput } from '../../shared/schema';

export function Cover({
  game,
  index = 0,
  className = '',
}: {
  game: Game;
  index?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const image = game.images[index];
  useEffect(() => setFailed(false), [image?.url]);
  return image && !failed ? (
    <img
      className={className}
      src={image.url}
      alt={image.alt || game.title}
      onError={() => setFailed(true)}
      loading="lazy"
    />
  ) : (
    <div className={`no-image ${className}`}>
      <Gamepad2 size={38} />
      <span>{game.title}</span>
    </div>
  );
}
export function Badge({ status }: { status: string }) {
  return <span className={`status-badge ${status === '进行中' ? 'playing' : ''}`}>{status}</span>;
}
export function GameCard({ game: g }: { game: Game }) {
  return (
    <Link className="game-card" to={`/games/${g.id}`}>
      <div className="card-image">
        <Cover game={g} />
        <Badge status={g.status} />
        {!g.is_published && <span className="private-badge">私密</span>}
      </div>
      <div className="card-body">
        <span className="card-platform">
          {g.platform || '平台未记录'}{' '}
          <span>{g.played_years[0] ? `· ${g.played_years[0]}` : ''}</span>
        </span>
        <h3 title={g.title}>{g.title}</h3>
        <div className="card-bottom">
          <span>{g.tags.slice(0, 2).join(' / ') || '类型未记录'}</span>
          <span>{g.hours === null ? '时长未记录' : `${g.hours} h`}</span>
        </div>
      </div>
    </Link>
  );
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty-state">
      <Gamepad2 size={38} />
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
    </div>
  );
}
export function Busy({ text = '正在载入…' }: { text?: string }) {
  return (
    <div className="busy">
      <LoaderCircle size={22} className="spin" />
      {text}
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭" onClick={onClose}>
          <X size={22} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Bars({
  games,
  by,
  onPick,
  limit = 10,
}: {
  games: Game[];
  by: ThemeInput['chart'];
  onPick?: (label: string) => void;
  limit?: number;
}) {
  const values = groupGames(games, by);
  const max = Math.max(1, ...values.map((v) => v.value));
  return (
    <div className="bar-chart">
      {values.slice(0, limit).map(({ label, value }) => (
        <button
          className="bar-row"
          key={label}
          disabled={!onPick}
          onClick={() => onPick?.(label)}
          title={`${label}：${value} 款游戏`}
        >
          <span className="bar-label">{label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(value / max) * 100}%` }} />
          </span>
          <span className="bar-value">{value}</span>
          {onPick && <ArrowUpRight size={14} />}
        </button>
      ))}
      {values.length === 0 && <p className="muted">暂无可统计的记录</p>}
    </div>
  );
}
