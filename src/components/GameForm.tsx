import { useState, type FormEvent } from 'react';
import { Plus, Save, X, Upload, LoaderCircle } from 'lucide-react';
import { gameInputSchema, statuses, type GameInput } from '../../shared/schema';
import { api } from '../lib/api';

const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v));
export default function GameForm({
  initial,
  onSave,
  configured = true,
  submitLabel = '保存游戏',
}: {
  initial?: Partial<GameInput>;
  onSave: (data: GameInput) => Promise<void>;
  configured?: boolean;
  submitLabel?: string;
}) {
  const [form, setForm] = useState<GameInput>(() => ({
    ...gameInputSchema.parse({ title: '未命名游戏' }),
    ...initial,
  }));
  const [years, setYears] = useState(form.played_years.join(', '));
  const [tags, setTags] = useState(form.tags.join(', '));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const set = <K extends keyof GameInput>(key: K, value: GameInput[K]) =>
    setForm((v) => ({ ...v, [key]: value }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const parsed = gameInputSchema.safeParse({
        ...form,
        played_years: [
          ...new Set(
            years
              .split(/[,，、\s]+/)
              .filter(Boolean)
              .map(Number),
          ),
        ],
        tags: [
          ...new Set(
            tags
              .split(/[,，、]+/)
              .map((v) => v.trim())
              .filter(Boolean),
          ),
        ],
      });
      if (!parsed.success)
        throw new Error(
          parsed.error.issues
            .map((v) => `${v.path.join('.')}: ${v.message}`)
            .slice(0, 3)
            .join('；'),
        );
      await onSave(parsed.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setUploading(true);
    setError('');
    try {
      const added: GameInput['images'] = [];
      for (const file of [...files].slice(0, 12 - form.images.length)) {
        const body = new FormData();
        body.append('file', file);
        const { url } = await api<{ url: string }>('/upload', { method: 'POST', body });
        added.push({ url, alt: form.title });
      }
      setForm((v) => ({ ...v, images: [...v.images, ...added] }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }
  return (
    <form className="game-form" onSubmit={submit}>
      {!configured && (
        <div className="notice">当前可预览填写界面。连接云端并使用 Google 账号登录后即可保存。</div>
      )}
      <section className="form-section">
        <div className="section-title">
          <span className="step-number">01</span>
          <h3>我的游玩记录</h3>
          <span className="muted">属于你的那部分</span>
        </div>
        <div className="form-grid">
          <label>
            游玩状态
            <select
              value={form.status}
              onChange={(e) => set('status', e.target.value as GameInput['status'])}
            >
              {statuses.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          <label>
            游玩平台
            <input
              value={form.platform}
              onChange={(e) => set('platform', e.target.value)}
              list="platforms"
              placeholder="例如 Steam、PlayStation"
            />
            <datalist id="platforms">
              {[
                'Steam',
                'PC',
                'PlayStation',
                'Xbox',
                'Switch',
                'Switch 2',
                'iOS',
                'PlayStationPortable',
              ].map((p) => (
                <option key={p}>{p}</option>
              ))}
            </datalist>
          </label>
          <label>
            游玩年份
            <input
              value={years}
              onChange={(e) => setYears(e.target.value)}
              placeholder="例如 2025, 2026"
            />
            <small>跨年游玩可填写多个年份</small>
          </label>
          <label>
            累计时长 / 小时
            <input
              type="number"
              min="0"
              max="100000"
              step="0.1"
              value={form.hours ?? ''}
              onChange={(e) => set('hours', numberOrNull(e.target.value))}
              placeholder="留空表示未记录"
            />
          </label>
          <label>
            我的评分 / 10 分
            <input
              type="number"
              min="0"
              max="10"
              step="0.1"
              value={form.personal_rating ?? ''}
              onChange={(e) => set('personal_rating', numberOrNull(e.target.value))}
              placeholder="可选"
            />
          </label>
          <label>
            可见范围
            <select
              value={form.is_published ? 'public' : 'private'}
              onChange={(e) => set('is_published', e.target.value === 'public')}
            >
              <option value="public">公开 · 朋友可以浏览</option>
              <option value="private">私密 · 仅自己可见</option>
            </select>
          </label>
          <label className="span-2">
            游玩感想
            <textarea
              rows={4}
              value={form.notes}
              onChange={(e) => set('notes', e.target.value)}
              placeholder="记下难忘的角色、关卡，或通关那一刻的感受…"
              maxLength={10000}
            />
          </label>
        </div>
      </section>
      <section className="form-section">
        <div className="section-title">
          <span className="step-number">02</span>
          <h3>游戏资料</h3>
        </div>
        <div className="form-grid">
          <label>
            游戏名称
            <input
              required
              value={form.title}
              maxLength={200}
              onChange={(e) => set('title', e.target.value)}
              placeholder="中文名称或常用名称"
            />
          </label>
          <label>
            英文名称
            <input
              value={form.english_title}
              onChange={(e) => set('english_title', e.target.value)}
            />
          </label>
          <label>
            日文名称
            <input
              value={form.japanese_title}
              onChange={(e) => set('japanese_title', e.target.value)}
            />
          </label>
          <label>
            开发商
            <input value={form.developer} onChange={(e) => set('developer', e.target.value)} />
          </label>
          <label>
            发行年份
            <input
              type="number"
              min="1950"
              max="2200"
              value={form.release_year ?? ''}
              onChange={(e) => set('release_year', numberOrNull(e.target.value))}
            />
          </label>
          <label>
            游戏系列
            <input
              value={form.series}
              onChange={(e) => set('series', e.target.value)}
              placeholder="例如 英雄传说"
            />
          </label>
          <label>
            游戏类型
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="RPG, JRPG, Adventure"
            />
            <small>多个类型用逗号分隔</small>
          </label>
          <label className="span-2">
            Wikipedia 链接
            <input
              type="url"
              value={form.wikipedia_url}
              onChange={(e) => set('wikipedia_url', e.target.value)}
            />
          </label>
        </div>
        <div className="subsection-heading">
          <h4>Metacritic 评分</h4>
          <button
            type="button"
            className="button small quiet"
            onClick={() => set('mc_scores', [...form.mc_scores, { platform: '', score: 0 }])}
          >
            <Plus size={15} />
            增加平台
          </button>
        </div>
        {form.mc_scores.map((mc, i) => (
          <div className="mc-edit" key={i}>
            <input
              aria-label={`评分平台 ${i + 1}`}
              placeholder="平台，例如 PC"
              value={mc.platform}
              onChange={(e) =>
                set(
                  'mc_scores',
                  form.mc_scores.map((s, j) => (j === i ? { ...s, platform: e.target.value } : s)),
                )
              }
            />
            <input
              aria-label={`${mc.platform || '平台'}评分`}
              type="number"
              min="0"
              max="100"
              required
              value={mc.score}
              onChange={(e) =>
                set(
                  'mc_scores',
                  form.mc_scores.map((s, j) =>
                    j === i ? { ...s, score: Number(e.target.value) } : s,
                  ),
                )
              }
            />
            <span className="muted">/ 100</span>
            <button
              type="button"
              className="icon-button"
              aria-label="移除评分"
              onClick={() =>
                set(
                  'mc_scores',
                  form.mc_scores.filter((_, j) => j !== i),
                )
              }
            >
              <X size={18} />
            </button>
          </div>
        ))}
      </section>
      <section className="form-section">
        <div className="section-title">
          <span className="step-number">03</span>
          <h3>游戏图片</h3>
          <span className="muted">第一张作为封面</span>
        </div>
        <div className="image-editor">
          {form.images.map((image, i) => (
            <div className="image-edit-item" key={image.url}>
              <img src={image.url} alt={image.alt} />
              <button
                type="button"
                className="icon-button"
                aria-label={`移除图片 ${i + 1}`}
                onClick={() =>
                  set(
                    'images',
                    form.images.filter((_, j) => j !== i),
                  )
                }
              >
                <X size={16} />
              </button>
              {i > 0 && (
                <button
                  type="button"
                  className="cover-choice"
                  onClick={() => set('images', [image, ...form.images.filter((_, j) => j !== i)])}
                >
                  设为封面
                </button>
              )}
            </div>
          ))}
          {form.images.length < 12 && (
            <label className={`image-upload ${!configured ? 'disabled' : ''}`}>
              <Upload size={24} />
              <span>{uploading ? '正在上传…' : '上传图片'}</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                disabled={!configured || uploading}
                onChange={(e) => void upload(e.target.files)}
              />
            </label>
          )}
        </div>
      </section>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <span className="muted">空白时长会按「未记录」保存</span>
        <button className="button primary" disabled={busy || uploading || !configured}>
          {busy ? <LoaderCircle size={18} className="spin" /> : <Save size={18} />} {submitLabel}
        </button>
      </div>
    </form>
  );
}
