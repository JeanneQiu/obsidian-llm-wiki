import { describe, it, expect, vi } from 'vitest';
import { TFile, requestUrl } from 'obsidian';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createWikiEngineHarness as originalHarness } from '../__support__/wiki-engine-harness';
import { renderDirectoryIndex, validateKnowledgePath } from '../../wiki/hierarchical-notes';
import { createLLMClient } from '../../core/create-plugin-llm-client';
import { preloadLLMClientModules } from '../../llm-sdk/create-llm-client';
import { DEFAULT_SETTINGS } from '../../types';

vi.mock('../../core/pdf-cache', async importOriginal => ({
  ...await importOriginal<typeof import('../../core/pdf-cache')>(),
  sha256Bytes: async (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
}));

function createWikiEngineHarness(options: Parameters<typeof originalHarness>[0]) {
  const h=originalHarness(options);
  Object.assign(h.app.vault, {adapter:{
    exists: async (path: string) => h.files.has(path) || [...h.files.keys()].some(p=>p.startsWith(path+'/')),
    mkdir: async () => {},
    read: async (path: string) => h.files.get(path) ?? '',
    write: async (path: string, body: string) => {h.files.set(path,body);},
    remove: async (path: string) => {h.files.delete(path);},
  }});
  return h;
}

describe('hierarchical study notes', () => {
  it('retries once when the writer omits the required learning sections', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'learn.md':'技术资料'},llmResponses:[JSON.stringify({paths:['学习/笔记.md']}),JSON.stringify({notes:[{path:'学习/笔记.md',content:'# 笔记\n'+ '普通正文但缺少摘要和知识细节章节。'.repeat(4)}]}),JSON.stringify({notes:[{path:'学习/笔记.md',content:'# 笔记\n\n## 摘要\n学习技术原理。\n\n## 知识细节\n'+'保留有依据的技术知识并记录原始资料来源。'.repeat(4)}]})]});
    await h.engine.ingestSource(h.app.vault.getAbstractFileByPath('learn.md') as TFile);
    expect(h.llmRequests).toHaveLength(3);
    expect(h.files.get('wiki/学习/笔记.md')).toContain('## 知识细节');
  });
  it.each(['markdown','text','srt','vtt','json','py'])('reads %s as UTF-8 text without MinerU', async extension => {
    const name='learn.'+extension;
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{[name]:'# 原文\n手工粘贴的文字稿与技术细节'},llmResponses:[JSON.stringify({paths:['学习/笔记.md']}),JSON.stringify({notes:[{path:'学习/笔记.md',content:'# 学习\n\n## 摘要\n整理文字稿。\n\n## 知识细节\n根据用户粘贴的技术内容整理，保留原始材料中有依据的细节。'}]})]});
    await h.engine.ingestSource(h.app.vault.getAbstractFileByPath(name) as TFile);
    expect(h.llmRequests[0].messages[0].content).toContain('手工粘贴');
    expect(h.files.get('wiki/学习/笔记.md')).toContain('文字稿');
  });

  it('retains accepted web text and extraction decisions through the real ingest entry', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true,tavilyExtractEnabled:true},files:{'learn.md':'https://example.com/guide'},llmResponses:[JSON.stringify({keep:true,reason:'技术教程'}),JSON.stringify({paths:['学习/网页.md']}),JSON.stringify({notes:[{path:'学习/网页.md',content:'# 网页\n\n## 摘要\n技术教程。\n\n## 知识细节\n通过阅读网页正文学习技术原理，并保留原文来源链接以便后续核实。'}]})]});
    Object.assign(h.app,{secretStorage:{getSecret:()=> 'test-key'}});
    vi.mocked(requestUrl).mockResolvedValueOnce({status:200,headers:{},text:JSON.stringify({results:[{url:'https://example.com/guide',raw_content:'# Guide\nActual technical webpage content'}],failed_results:[]}),json:{},arrayBuffer:new ArrayBuffer(0)});
    await h.engine.ingestSource(h.app.vault.getAbstractFileByPath('learn.md') as TFile);
    expect(h.llmRequests[0].task).toBe('hierarchy-web-assess');
    expect(h.llmRequests[1].messages[0].content).toContain('Actual technical webpage content');
    const raw=[...h.files.entries()].find(([path])=>path.startsWith('wiki/原始资料/learn-'))?.[1];
    expect(raw).toContain('https://example.com/guide');
    expect(raw).toContain('网页提取记录');
    expect(raw).not.toContain('test-key');
  });

  it('does not turn a rejected link-only source into invented notes', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true,tavilyExtractEnabled:true},files:{'learn.md':'https://example.com/login'},llmResponses:[JSON.stringify({keep:false,reason:'登录页'})]});
    Object.assign(h.app,{secretStorage:{getSecret:()=> 'test-key'}});
    vi.mocked(requestUrl).mockResolvedValueOnce({status:200,headers:{},text:JSON.stringify({results:[{url:'https://example.com/login',raw_content:'Sign in'}],failed_results:[]}),json:{},arrayBuffer:new ArrayBuffer(0)});
    await expect(h.engine.ingestSource(h.app.vault.getAbstractFileByPath('learn.md') as TFile)).rejects.toThrow('没有可保留');
    expect([...h.files.keys()].some(path=>path.startsWith('wiki/学习'))).toBe(false);
    expect(h.llmRequests).toHaveLength(1);
  });

  it('renders only direct children as a plain directory', () => {
    const result = renderDirectoryIndex('Agent', ['Agent/Memory/index.md', 'Agent/Overview.md', 'Agent/index.md', 'Agent/Memory/Long.md']);
    expect(result).toBe('# Agent\n\n- [Memory](<Memory/index.md>)\n- [Overview](<Overview.md>)\n');
  });

  it('rejects paths that escape or replace the directory', () => {
    for (const path of ['../outside.md', '/outside.md', '.private/test.md', 'Topic/index.md', '原始资料/test.md', 'A\\B.md']) {
      expect(() => validateKnowledgePath(path)).toThrow();
    }
    expect(validateKnowledgePath('Agent/Memory/Long.md')).toBe('Agent/Memory/Long.md');
  });

  it('uses the new planner through the existing ingest entry point', async () => {
    const h = createWikiEngineHarness({
      settings: { hierarchicalNotes: true },
      files: { 'learn.md': '# RAG\nRetrieve sources and cite them.' },
      llmResponses: [JSON.stringify({paths:['AI/RAG/检索.md']}), JSON.stringify({notes:[{path:'AI/RAG/检索.md', content:'# 检索\n\n## 摘要\n基于资料回答。\n\n## 知识细节\n检索资料后，结合问题生成回答，并保留引用，以便核实结论。'}]})],
    });
    const file=h.app.vault.getAbstractFileByPath('learn.md') as TFile;
    await h.engine.ingestSource(file);
    expect(h.files.get('wiki/AI/RAG/检索.md')).toContain('知识细节');
    expect(h.files.get('wiki/AI/index.md')).toContain('RAG/index.md');
    expect(h.files.get('wiki/index.md')).not.toContain('知识概述');
    expect(h.llmRequests).toHaveLength(2);
    expect(h.llmRequests[0].task).toBe('hierarchy-plan');
    expect(h.engine.isIngesting()).toBe(false);
    expect(h.reports[0].success).toBe(true);
  });

  it('backs up hand-written notes and skips unchanged input', async () => {
    const old='# 用户笔记\n人工知识';
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'source.md':'# 学习\n新资料', 'wiki/AI/知识.md':old},llmResponses:[JSON.stringify({paths:['AI/知识.md']}),JSON.stringify({notes:[{path:'AI/知识.md',content:'# 知识\n\n## 摘要\n综合已有人工知识与新资料。\n\n## 知识细节\n这里保留人工知识，同时加入来自新资料的内容。'}]})]});
    const file=h.app.vault.getAbstractFileByPath('source.md') as TFile;
    await h.engine.ingestSource(file);
    expect([...h.files.entries()].some(([path,text])=>path.includes('/.jeans-wiki/backups/')&&text===old)).toBe(true);
    expect(h.llmRequests[1].messages[0].content).toContain('人工知识');
    await h.engine.ingestSource(file);
    expect(h.stats.llmCalls).toBe(2);
  });

  it('does not commit a malformed model response', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'source.md':'# 学习\n原文','wiki/AI/知识.md':'unchanged'},llmResponses:[JSON.stringify({paths:['AI/知识.md']}),JSON.stringify({notes:[{path:'../escape.md',content:'invalid'}]})]});
    await expect(h.engine.ingestSource(h.app.vault.getAbstractFileByPath('source.md') as TFile)).rejects.toThrow();
    expect(h.files.get('wiki/AI/知识.md')).toBe('unchanged');
    expect(h.engine.isIngesting()).toBe(false);
  });

  it('rebuilds directory links after a manual move without LLM calls', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'wiki/新领域/知识.md':'# 知识','wiki/旧领域/index.md':'stale'}});
    await h.engine.generateIndexFromEngine();
    expect(h.files.get('wiki/新领域/index.md')).toContain('知识.md');
    expect(h.files.get('wiki/旧领域/index.md')).not.toContain('stale');
    expect(h.stats.llmCalls).toBe(0);
  });

  it('stops batch cancellation at the existing engine boundary', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'source.md':'# 原文'},beforeLLMCall:()=>{throw new DOMException('Cancelled','AbortError');}});
    await h.engine.ingestSource(h.app.vault.getAbstractFileByPath('source.md') as TFile);
    expect(h.engine.wasCancelled).toBe(true);
    expect(h.reports[0].cancelled).toBe(true);
    expect(h.engine.isIngesting()).toBe(false);
  });

  it('rejects concurrent manual edits rather than restoring a stale path', async () => {
    const h=createWikiEngineHarness({settings:{hierarchicalNotes:true},files:{'source.md':'# 原文','wiki/AI/知识.md':'原始人工笔记'},llmResponses:[JSON.stringify({paths:['AI/知识.md']}),JSON.stringify({notes:[{path:'AI/知识.md',content:'# 知识\n\n## 摘要\n更新\n\n## 知识细节\n'+'这是根据资料撰写的知识细节。'.repeat(8)}]})],beforeLLMCall:call=>{if(call===1)h.files.set('wiki/AI/知识.md','用户在模型运行时改了这篇笔记');}});
    await expect(h.engine.ingestSource(h.app.vault.getAbstractFileByPath('source.md') as TFile)).rejects.toThrow('发生了编辑或移动');
    expect(h.files.get('wiki/AI/知识.md')).toBe('用户在模型运行时改了这篇笔记');
  });

  it.runIf(process.env.JEAN_WIKI_LIVE === '1')('uses the upstream client with Magpie and persists readable notes', async () => {
    vi.mocked(requestUrl).mockImplementation(options => {
      const p = typeof options === 'string' ? {url: options} : options;
      const pending = (async () => {
        const response = await fetch(p.url, {method:p.method, headers:p.headers, body:p.body as string | undefined});
        const text = await response.text();
        const headers: Record<string,string> = {};
        response.headers.forEach((value,key)=>{headers[key]=value;});
        return {status:response.status,headers,text,json:JSON.parse(text),arrayBuffer:new TextEncoder().encode(text).buffer};
      })();
      return Object.assign(pending, {text:pending.then(r=>r.text),json:pending.then(r=>r.json),arrayBuffer:pending.then(r=>r.arrayBuffer)});
    });
    await preloadLLMClientModules();
    const settings = {...DEFAULT_SETTINGS, provider:'custom', apiKey:'magpie-local', baseUrl:'http://127.0.0.1:3425/v1', model:'deepseek/deepseek-flash', hierarchicalNotes:true,tavilyExtractEnabled:!!process.env.JEAN_TAVILY_KEY};
    const client = createLLMClient(settings);
    const source='# RAG 学习记录\n\nRAG 先解析资料、分块并建立索引。回答时检索相关片段，将其与问题交给模型生成回答。混合检索结合关键词匹配和向量检索：前者适合精确术语，后者适合语义匹配。重排对召回候选再次排序。评估需要分别检查相关资料是否被检索到、回答是否正确引用来源。这是配置测试的合成笔记，不是论文结论。';
    const input=process.env.JEAN_TAVILY_KEY ? '# Tavily 网页学习验证\n\nhttps://docs.tavily.com/documentation/about' : source;
    const h=createWikiEngineHarness({settings,files:{'学习资料.md':input}});
    if (process.env.JEAN_TAVILY_KEY) Object.assign(h.app,{secretStorage:{getSecret:()=>process.env.JEAN_TAVILY_KEY}});
    Object.assign(h.engine, {getLLMClient:()=>client});
    await h.engine.ingestSource(h.app.vault.getAbstractFileByPath('学习资料.md') as TFile);
    expect(h.reports[0].success).toBe(true);
    expect(h.reports[0].createdPages.length).toBeGreaterThan(0);
    for (const path of h.reports[0].createdPages) expect(h.files.get(path)).toContain('知识细节');
    expect(h.files.get('wiki/log.md')).toContain('学习资料');
    if (process.env.JEAN_TAVILY_KEY) {
      const raw=[...h.files.entries()].find(([path])=>path.startsWith('wiki/原始资料/学习资料-'))?.[1] ?? '';
      expect(raw).toContain('## 网页来源：https://docs.tavily.com/documentation/about');
      expect(raw.length).toBeGreaterThan(1000);
      expect(raw).not.toContain(process.env.JEAN_TAVILY_KEY);
    }
    if (process.env.JEAN_WIKI_LIVE_OUTPUT) writeFileSync(process.env.JEAN_WIKI_LIVE_OUTPUT,JSON.stringify(Object.fromEntries(h.files),null,2));
  },180000);
});
