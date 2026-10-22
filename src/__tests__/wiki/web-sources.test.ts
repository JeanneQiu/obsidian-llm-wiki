import { describe, expect, it, vi } from 'vitest';
import { extractWebSources, findWebLinks } from '../../wiki/web-sources';

describe('linked web sources', () => {
  it('preserves balanced parentheses within bare and markdown links', () => {
    expect(findWebLinks('[Wiki](https://example.com/Topic_(detail)) https://example.com/Topic_(detail).')).toEqual(['https://example.com/Topic_(detail)']);
  });
  it('does not include sentence punctuation in a bare URL', () => {
    expect(findWebLinks('See https://example.com/guide, then continue.')).toEqual(['https://example.com/guide']);
  });

  it('releases ingestion promptly when cancelled during the request', async () => {
    const controller=new AbortController();
    const transport=vi.fn().mockImplementation(()=>new Promise(()=>{}));
    const pending=extractWebSources('https://example.com','key',vi.fn(),controller.signal,transport);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('rejects an excessive total before calling the model', async () => {
    const transport=vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[{url:'https://example.com/a',raw_content:'a'.repeat(70000)},{url:'https://example.com/b',raw_content:'b'.repeat(70000)}]})));
    const judge=vi.fn();
    await expect(extractWebSources('https://example.com/a https://example.com/b','key',judge,undefined,transport)).rejects.toThrow('12 万');
    expect(judge).not.toHaveBeenCalled();
  });
  it('deduplicates public links and ignores images, code, local hosts and video links', () => {
    expect(findWebLinks('[Guide](https://example.com/guide#one) https://example.com/guide#two\n![image](https://example.com/a.png)\n`https://example.com/code`\n```\nhttps://example.com/code2\n```\nhttp://localhost:8080 https://127.0.0.1 https://foo.local https://youtube.com/watch?v=1 https://www.bilibili.com/video/BV1')).toEqual(['https://example.com/guide']);
  });

  it('retrieves full markdown and lets the model decide what to retain', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({results:[{url:'https://example.com/a', raw_content:'# Article\nTechnical details'},{url:'https://example.com/b',raw_content:'Sign in'}],failed_results:[]})));
    const judge = vi.fn().mockResolvedValueOnce({keep:true,reason:'Technical article'}).mockResolvedValueOnce({keep:false,reason:'Login page'});
    const result = await extractWebSources('https://example.com/a https://example.com/b','test-key',judge,undefined,transport);
    expect(result.content).toContain('Technical details');
    expect(result.content).toContain('https://example.com/a');
    expect(result.content).not.toContain('Sign in');
    expect(result.decisions).toHaveLength(2);
    const body = JSON.parse(transport.mock.calls[0][1].body as string) as Record<string,unknown>;
    expect(body.format).toBe('markdown');
    expect(body).not.toHaveProperty('query');
    expect(judge.mock.calls[0][0]).toContain('Technical details');
  });

  it('stops on missing key, API failure, partial failure or invalid model judgment', async () => {
    const judge=vi.fn();
    await expect(extractWebSources('https://example.com','',judge)).rejects.toThrow('Tavily');
    const transport=vi.fn().mockResolvedValue(new Response('{}',{status:401}));
    await expect(extractWebSources('https://example.com','key',judge,undefined,transport)).rejects.toThrow('401');
    transport.mockResolvedValue(new Response(JSON.stringify({results:[],failed_results:[{url:'https://example.com',error:'error'}]})));
    await expect(extractWebSources('https://example.com','key',judge,undefined,transport)).rejects.toThrow('提取失败');
    transport.mockResolvedValue(new Response(JSON.stringify({results:[{url:'https://example.com/',raw_content:'body'}],failed_results:[]})));
    judge.mockResolvedValue({keep:'yes'});
    await expect(extractWebSources('https://example.com','key',judge,undefined,transport)).rejects.toThrow();
  });

  it('does no network work for plain transcripts, and observes cancellation', async () => {
    const transport=vi.fn();
    expect((await extractWebSources('手工粘贴的字幕','',vi.fn(),undefined,transport)).content).toBe('');
    expect(transport).not.toHaveBeenCalled();
    const controller=new AbortController(); controller.abort();
    await expect(extractWebSources('https://example.com','key',vi.fn(),controller.signal,transport)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
});
