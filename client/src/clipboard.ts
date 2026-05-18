// clipboard.ts
// クリップボード / シェアの共通ヘルパー。
// 環境ごとの違い (HTTPS / iOS Safari / モバイル / 旧ブラウザ) を吸収。

export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    if (textarea.setSelectionRange) textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function shareOrCopy(text: string, title?: string): Promise<ShareResult> {
  if (typeof navigator !== 'undefined' && (navigator as any).share) {
    try {
      // text と url 両方を渡すと一部のシェア先 (LINE 等) で URL が二重に貼られるため、
      // URL なら url のみ、それ以外は text のみを渡す。
      const isUrl = /^https?:\/\//i.test(text);
      const payload = isUrl ? { title, url: text } : { title, text };
      await (navigator as any).share(payload);
      return 'shared';
    } catch (err: any) {
      if (err && (err.name === 'AbortError' || err.message === 'Share canceled')) {
        return 'cancelled';
      }
    }
  }
  const ok = await copyText(text);
  return ok ? 'copied' : 'failed';
}
