import { useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import type { SetURLSearchParams } from 'react-router-dom';
import { z } from 'zod';
import type { Game } from '../../shared/schema';
import { librarySearchSchema, searchLibrary } from '../../shared/library';
type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema: object;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => unknown;
    },
    options: { signal: AbortSignal },
  ) => void | Promise<void>;
};
export function useLibraryTools(games: Game[], setParams: SetURLSearchParams) {
  const latest = useRef({ games, setParams });
  latest.current = { games, setParams };
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const controller = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'search_game_library',
            description:
              'Search the visible Playtrace game library and update its filters. Returns matching game IDs and titles. This changes the current view without editing stored game records.',
            inputSchema: z.toJSONSchema(librarySearchSchema),
            annotations: { readOnlyHint: false, untrustedContentHint: true },
            execute(input) {
              const values = librarySearchSchema.parse(input);
              const params = new URLSearchParams();
              for (const [k, v] of Object.entries(values)) if (v) params.set(k, v);
              const matches = searchLibrary(latest.current.games, params);
              flushSync(() => latest.current.setParams(params, { replace: true }));
              return {
                count: matches.length,
                games: matches.map((g) => ({ id: g.id, title: g.title })),
              };
            },
          },
          { signal: controller.signal },
        ),
      ).catch(() => {});
    } catch {
      /* Unsupported browsers keep the ordinary interface. */
    }
    return () => controller.abort();
  }, []);
}
