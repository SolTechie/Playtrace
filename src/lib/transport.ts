export const isDesktop = import.meta.env.MODE === 'desktop';

type NativeResponse = { status: number; body: string };
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        playtrace?: {
          postMessage: (request: {
            path: string;
            method: string;
            body: string;
            contentType: string;
          }) => Promise<NativeResponse>;
        };
      };
    };
  }
}

export async function apiFetch(path: string, options: RequestInit = {}): Promise<Response> {
  if (!isDesktop) return fetch(`/api${path}`, { ...options, credentials: 'same-origin' });
  const bridge = window.webkit?.messageHandlers?.playtrace;
  if (!bridge) throw new Error('桌面连接不可用，请重新打开玩迹。');
  const payload = options.body == null ? null : new Response(options.body);
  const bytes = payload ? new Uint8Array(await payload.arrayBuffer()) : new Uint8Array();
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  const result = await bridge.postMessage({
    path,
    method: options.method || 'GET',
    contentType:
      options.body instanceof FormData ? payload!.headers.get('content-type')! : 'application/json',
    body: btoa(chunks.join('')),
  });
  return new Response(
    Uint8Array.from(atob(result.body), (char) => char.charCodeAt(0)),
    {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // WKWebView custom origins may not expose the Clipboard API. This still
    // requires a user click, and grants no native file or command access.
    const field = document.createElement('textarea');
    field.value = text;
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    if (!copied) throw new Error('请选中说明后复制。');
  }
}
