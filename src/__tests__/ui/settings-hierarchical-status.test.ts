import { describe, expect, it } from 'vitest';
import { LLMWikiSettingTab } from '../../ui/settings';

describe('hierarchical wiki status', () => {
  function initialized(hierarchicalNotes: boolean, paths: string[]): boolean {
    const tab = {
      tempSettings: { wikiFolder: 'Wiki', hierarchicalNotes },
      app: { vault: { getAbstractFileByPath: (path: string) => paths.includes(path) ? {path} : null } },
    } as unknown as LLMWikiSettingTab;
    return LLMWikiSettingTab.prototype.isWikiInitialized.call(tab);
  }
  it('recognizes a hierarchical index without legacy classification folders', () => {
    expect(initialized(true, ['Wiki/index.md'])).toBe(true);
    expect(initialized(true, [])).toBe(false);
  });
  it('retains the legacy mode structure check', () => {
    expect(initialized(false, ['Wiki/index.md'])).toBe(false);
    expect(initialized(false, ['Wiki/entities', 'Wiki/concepts', 'Wiki/sources', 'Wiki/schema'])).toBe(true);
  });
});
