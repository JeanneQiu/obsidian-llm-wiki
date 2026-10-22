import { describe, expect, it } from 'vitest';
import { getSourceExtensions, TEXT_SOURCE_EXTENSIONS } from '../../core/source-formats';
import { COMPATIBLE_SOURCE_EXTENSIONS } from '../../constants';

describe('hierarchical source formats', () => {
  it('preserves legacy defaults and offers text formats in hierarchical mode', () => {
    expect(getSourceExtensions()).toEqual(COMPATIBLE_SOURCE_EXTENSIONS);
    const formats=getSourceExtensions({hierarchicalNotes:true});
    for (const extension of ['markdown','text','srt','vtt','csv','json','yaml','py','ts','html']) expect(formats).toContain(extension);
    expect(formats).not.toContain('docx');
    expect(TEXT_SOURCE_EXTENSIONS).not.toContain('pdf');
  });
  it('offers MinerU documents and images only with the MinerU backend', () => {
    const formats=getSourceExtensions({hierarchicalNotes:true,markdownConversionBackend:'mineru'});
    for (const extension of ['pdf','doc','docx','ppt','pptx','xls','xlsx','jpg','png']) expect(formats).toContain(extension);
    expect(formats).not.toContain('mp4');
    expect(formats).not.toContain('zip');
  });
});
