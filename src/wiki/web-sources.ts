import { z } from 'zod';
import { obsidianFetchBridge } from '../core/obsidian-fetch-bridge';

export const TAVILY_SECRET_ID = 'karpathywiki-tavily-api-key';
const judgment = z.object({ keep: z.boolean(), reason: z.string() });
const extraction = z.object({
  results: z.array(z.object({url:z.string(), raw_content:z.string().nullable()})),
  failed_results: z.array(z.unknown()).optional().default([]),
});

export function findWebLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!\[[^\]]*\]\([^\n]*?\)/g, '');
  const links = new Set<string>();
  for (const match of prose.matchAll(/https?:\/\/[^\s<>"'`\u3000-\u303f\uff00-\uffef]+/g)) {
    try {
      let target = match[0].replace(/[,.;!?\]]+$/, '');
      while (target.endsWith(')') && (target.match(/\)/g)?.length ?? 0) > (target.match(/\(/g)?.length ?? 0)) target = target.slice(0,-1);
      const url = new URL(target);
      const host = url.hostname.toLowerCase();
      if (url.username || url.password || !host.includes('.') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host) || /\.(local|internal|localhost)$/.test(host)) continue;
      if (/(^|\.)(youtube\.com|youtu\.be|bilibili\.com|b23\.tv)$/.test(host)) continue;
      if (/\.(png|jpe?g|gif|svg|webp|ico|mp[34]|wav|ogg|webm|mov)$/i.test(url.pathname)) continue;
      url.hash = '';
      links.add(url.href);
    } catch { /* Ignore malformed links in pasted text. */ }
  }
  return [...links];
}

/** requestUrl cannot abort its socket; release the caller and discard late results. */
async function waitForExtraction(request: Promise<Response>, signal?: AbortSignal): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const finish = (action: () => void) => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    const timer = window.setTimeout(() => finish(() => reject(new Error('Tavily timeout'))), 90000);
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    request.then(value => finish(() => resolve(value)), () => finish(() => reject(new Error('Tavily request failed'))));
  });
}

export async function extractWebSources(
  text: string,
  apiKey: string,
  judge: (page: string) => Promise<unknown>,
  signal?: AbortSignal,
  transport: typeof obsidianFetchBridge = obsidianFetchBridge,
): Promise<{content: string; decisions: {url: string; keep: boolean; reason: string}[]}> {
  const urls = findWebLinks(text);
  if (!urls.length) return {content:'', decisions:[]};
  signal?.throwIfAborted();
  if (!apiKey.trim()) throw new Error('请先在插件设置中填写 Tavily API Key');
  if (urls.length > 20) throw new Error('单份资料超过 20 个网页链接，请拆分后摄入');
  let response: Response;
  try {
    response = await waitForExtraction(transport('https://api.tavily.com/extract', {
      method:'POST', headers:{Authorization:'Bearer ' + apiKey.trim(), 'Content-Type':'application/json'},
      body:JSON.stringify({urls, extract_depth:'advanced', format:'markdown', include_images:false, timeout:60}), signal,
    }), signal);
  } catch {
    signal?.throwIfAborted();
    throw new Error('Tavily 网络请求失败，请检查网络后重试');
  }
  signal?.throwIfAborted();
  if (!response.ok) throw new Error('Tavily 请求失败（HTTP ' + response.status + '）');
  const pages = extraction.parse(await response.json());
  if (pages.failed_results.length || pages.results.length !== urls.length) throw new Error('Tavily 网页提取失败或结果不完整；本轮未提交，请检查链接后重试');
  if (pages.results.reduce((total,page) => total + (page.raw_content?.length ?? 0),0) > 120000) throw new Error('网页正文合计超过 12 万字符，请按链接拆分后摄入');
  const content: string[] = [];
  const decisions: {url:string; keep:boolean; reason:string}[] = [];
  for (const page of pages.results) {
    signal?.throwIfAborted();
    if (!urls.includes(page.url) || decisions.some(item => item.url === page.url)) throw new Error('Tavily 返回了不匹配的网页地址');
    const body = page.raw_content?.trim() ?? '';
    // Assessment sees a bounded sample; an accepted page is retained in full.
    const decision = body ? judgment.parse(await judge(JSON.stringify({url:page.url, content:body.slice(0,16000)}))) : {keep:false,reason:'网页正文为空'};
    decisions.push({url:page.url,...decision});
    if (decision.keep) content.push(`## 网页来源：${page.url}\n\n${body}`);
  }
  return {content:content.join('\n\n'), decisions};
}
