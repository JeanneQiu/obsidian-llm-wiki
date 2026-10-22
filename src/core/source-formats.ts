import type { LLMWikiSettings } from '../types';
import { COMPATIBLE_SOURCE_EXTENSIONS, MINERU_CONVERSION_EXTENSIONS } from '../constants';

/** UTF-8 source text does not need OCR or a remote conversion service. */
export const TEXT_SOURCE_EXTENSIONS: readonly string[] = [
  'md', 'markdown', 'txt', 'text', 'srt', 'vtt', 'csv', 'tsv',
  'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'rst', 'adoc', 'tex', 'log', 'py', 'js', 'jsx', 'ts', 'tsx',
  'c', 'h', 'cpp', 'hpp', 'java', 'go', 'rs', 'sh', 'sql', 'css',
];

export function getSourceExtensions(settings?: Pick<LLMWikiSettings, 'hierarchicalNotes' | 'markdownConversionBackend'>): readonly string[] {
  if (!settings?.hierarchicalNotes) return COMPATIBLE_SOURCE_EXTENSIONS;
  return [...TEXT_SOURCE_EXTENSIONS, ...(settings.markdownConversionBackend === 'mineru' ? MINERU_CONVERSION_EXTENSIONS : ['pdf'])];
}
