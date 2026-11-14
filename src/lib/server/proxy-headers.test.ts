import {
  buildUpstreamMediaHeaders,
  isGuaziMediaHost,
} from './proxy-headers';

describe('proxy upstream media headers', () => {
  it('recognizes Guazi media hosts', () => {
    expect(isGuaziMediaHost('https://vd.wmvbo.com/a/index.m3u8')).toBe(true);
    expect(isGuaziMediaHost('https://wjm.eny7kg.com/a/index.m3u8')).toBe(true);
    expect(isGuaziMediaHost('https://example.com/a/index.m3u8')).toBe(false);
  });

  it('uses a player UA and no Referer for Guazi hosts', () => {
    const headers = buildUpstreamMediaHeaders(
      'https://vd.wmvbo.com/a/index.m3u8'
    );
    expect(headers['User-Agent']).toBe('Lavf/57.83.100');
    expect(headers.Referer).toBeUndefined();
  });

  it('uses a player UA and no Referer for Guazi sources', () => {
    const headers = buildUpstreamMediaHeaders(
      'https://example.com/a/index.m3u8',
      'guazi_app'
    );
    expect(headers['User-Agent']).toBe('Lavf/57.83.100');
    expect(headers.Referer).toBeUndefined();
  });

  it('keeps browser headers for other sources', () => {
    const headers = buildUpstreamMediaHeaders(
      'https://example.com/a/index.m3u8',
      'other-source'
    );
    expect(headers['User-Agent']).toContain('Mozilla/5.0');
    expect(headers.Referer).toBe('https://example.com/');
  });
});
