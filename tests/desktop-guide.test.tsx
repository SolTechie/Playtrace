import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Studio from '../src/pages/Studio';

vi.mock('../src/App', () => ({
  useStore: () => ({ games: [{ id: 'hades-2', title: '哈迪斯2', english_title: 'Hades II' }] }),
}));

describe('desktop instructions for old AI links', () => {
  it('ignores URL prompts and jobs while preserving the selected game for manual editing', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/studio?game=hades-2&job=old-job&prompt=REMOTE_INSTRUCTION']}>
        <Studio />
      </MemoryRouter>,
    );
    expect(html).toContain('网页 AI 任务和电脑自动连接已停用');
    expect(html).toContain('哈迪斯2');
    expect(html).toContain('/games/hades-2/edit');
    expect(html).not.toContain('REMOTE_INSTRUCTION');
    expect(html).not.toContain('old-job');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('连接电脑');
  });
});
