/** @jest-environment node */
jest.mock('@/lib/db', () => ({
  db: { getGlobalValue: jest.fn(), setGlobalValue: jest.fn() },
}));
jest.mock('nanoid', () => {
  let nextId = 0;
  return { nanoid: () => `script-${++nextId}` };
});
// Jest 27 does not resolve package-export subpaths; HTML is unused here.
jest.mock('cheerio/slim', () => ({ load: jest.fn() }), { virtual: true });

import { db } from './db';
import {
  executeSavedSourceScript,
  importSourceScripts,
  listEnabledSourceScripts,
  listSourceScripts,
  normalizeScriptDetailResult,
  resolveSavedScriptPlayUrl,
  saveSourceScript,
  setSourceScriptProxyMode,
} from './source-script';

const code =
  'return { meta: {name:"Source"}, detail(){return {title:"Movie",episodes:["https://cdn.example/movie.m3u8"]}}, resolvePlayUrl(){return {url:"https://cdn.example/movie.m3u8",type:"hls",proxyMode:true}} };';
const input = { key: 'guazi', name: '瓜子', code };

beforeEach(async () => {
  jest.useFakeTimers();
  let persisted: string | null = null;
  (db.getGlobalValue as jest.Mock).mockImplementation(async () => persisted);
  (db.setGlobalValue as jest.Mock).mockImplementation(
    async (_key: string, value: string) => {
      persisted = value;
    }
  );
  // Invalidates the in-memory registry cache between tests.
  const current = await listSourceScripts();
  current.splice(0);
  await importSourceScripts([]);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('new and imported scripts default to direct, even when script code requests proxying', async () => {
  const saved = await saveSourceScript(input);
  expect(saved.proxyMode).toBe(false);
  const playback = await resolveSavedScriptPlayUrl({
    key: input.key,
    sourceId: 'guazi',
    episodeIndex: 0,
    playUrl: 'raw',
  });
  expect(playback.proxyMode).toBe(false);
  expect(
    (await importSourceScripts([{ key: 'other', name: 'Other', code }]))[0]
      .proxyMode
  ).toBe(false);
});

test('saving the switch persists it and exposes it in detail and playback metadata', async () => {
  const saved = await saveSourceScript({ ...input, proxyMode: true });
  const execution = await executeSavedSourceScript({
    key: input.key,
    hook: 'detail',
  });
  const detail = normalizeScriptDetailResult({
    source: 'script:guazi:guazi',
    scriptKey: 'guazi',
    scriptName: 'Source',
    sourceId: 'guazi',
    sourceName: '瓜子',
    detailId: 'movie',
    result: execution.result,
    proxyMode: execution.proxyMode,
  });
  expect(detail.proxyMode).toBe(true);
  expect(
    (
      await resolveSavedScriptPlayUrl({
        key: input.key,
        sourceId: 'guazi',
        episodeIndex: 0,
        playUrl: 'raw',
      })
    ).proxyMode
  ).toBe(true);
  expect(
    JSON.parse((db.setGlobalValue as jest.Mock).mock.calls.slice(-1)[0][1])
      .items[0].proxyMode
  ).toBe(true);
  await saveSourceScript({ ...input, id: saved.id, proxyMode: false });
  expect((await listSourceScripts())[0].proxyMode).toBe(false);
});

test('old imports retain an explicit setting while new imports can disable it', async () => {
  await saveSourceScript({ ...input, proxyMode: true });
  await importSourceScripts([input]);
  expect((await listSourceScripts())[0].proxyMode).toBe(true);
  await importSourceScripts([{ ...input, proxyMode: false }]);
  expect((await listSourceScripts())[0].proxyMode).toBe(false);
});

test('each script has an independent proxy switch and retains its own code', async () => {
  const first = await saveSourceScript(input);
  const second = await saveSourceScript({
    ...input,
    key: 'backup',
    name: '备用源',
  });
  await setSourceScriptProxyMode(first.id, true);
  let scripts = await listSourceScripts();
  expect(scripts.find((item) => item.id === first.id)?.proxyMode).toBe(true);
  expect(scripts.find((item) => item.id === second.id)?.proxyMode).toBe(false);
  expect(
    (
      await resolveSavedScriptPlayUrl({
        key: second.key,
        sourceId: 'main',
        episodeIndex: 0,
        playUrl: 'raw',
      })
    ).proxyMode
  ).toBe(false);
  await setSourceScriptProxyMode(second.id, true);
  await setSourceScriptProxyMode(first.id, false);
  scripts = await listSourceScripts();
  expect(scripts.find((item) => item.id === first.id)?.proxyMode).toBe(false);
  expect(scripts.find((item) => item.id === second.id)?.proxyMode).toBe(true);
  expect(scripts.every((item) => item.code === code)).toBe(true);
});

test('an invalid script switch update cannot modify other scripts', async () => {
  const saved = await saveSourceScript(input);
  await expect(setSourceScriptProxyMode('missing-id', true)).rejects.toThrow(
    '脚本不存在'
  );
  expect(
    (await listSourceScripts()).find((item) => item.id === saved.id)?.proxyMode
  ).toBe(false);
});

test('App proxy defaults off independently of an enabled legacy web proxy', async () => {
  const saved = await saveSourceScript({ ...input, proxyMode: true });
  expect(saved.appProxyMode).toBe(false);
  expect((await listEnabledSourceScripts())[0]).toMatchObject({
    proxyMode: true,
    appProxyMode: false,
  });
});

test('App and web switches persist independently for each script', async () => {
  const first = await saveSourceScript(input);
  const second = await saveSourceScript({ ...input, key: 'backup' });
  await setSourceScriptProxyMode(first.id, true, 'app');
  await setSourceScriptProxyMode(second.id, true, 'web');
  const records = await listSourceScripts();
  expect(records.find((item) => item.id === first.id)).toMatchObject({
    proxyMode: false,
    appProxyMode: true,
  });
  expect(records.find((item) => item.id === second.id)).toMatchObject({
    proxyMode: true,
    appProxyMode: false,
  });
  await setSourceScriptProxyMode(first.id, true, 'web');
  expect(await setSourceScriptProxyMode(first.id, false, 'app')).toMatchObject({
    proxyMode: true,
    appProxyMode: false,
  });
});

test('saving code and old imports preserve both settings; explicit flags can change them', async () => {
  const saved = await saveSourceScript({
    ...input,
    proxyMode: true,
    appProxyMode: true,
  });
  await saveSourceScript({ ...input, id: saved.id });
  await importSourceScripts([input]);
  expect((await listSourceScripts())[0]).toMatchObject({
    proxyMode: true,
    appProxyMode: true,
  });
  await importSourceScripts([{ ...input, appProxyMode: false }]);
  expect((await listSourceScripts())[0]).toMatchObject({
    proxyMode: true,
    appProxyMode: false,
  });
  expect(
    (await importSourceScripts([{ ...input, key: 'new' }]))[0]
  ).toMatchObject({
    proxyMode: false,
    appProxyMode: false,
  });
});

test('execution, detail and playback expose both saved settings', async () => {
  await saveSourceScript({ ...input, proxyMode: false, appProxyMode: true });
  const execution = await executeSavedSourceScript({
    key: input.key,
    hook: 'detail',
  });
  const detail = normalizeScriptDetailResult({
    source: 'script:guazi:guazi',
    scriptKey: 'guazi',
    scriptName: 'Source',
    sourceId: 'guazi',
    sourceName: '瓜子',
    detailId: 'movie',
    result: execution.result,
    proxyMode: execution.proxyMode,
    appProxyMode: execution.appProxyMode,
  });
  expect(detail).toMatchObject({ proxyMode: false, appProxyMode: true });
  expect(
    await resolveSavedScriptPlayUrl({
      key: input.key,
      sourceId: 'guazi',
      episodeIndex: 0,
      playUrl: 'raw',
    })
  ).toMatchObject({ proxyMode: false, appProxyMode: true });
});

test('an unknown proxy client cannot alter saved settings', async () => {
  const saved = await saveSourceScript(input);
  await expect(
    setSourceScriptProxyMode(saved.id, true, 'invalid' as 'app')
  ).rejects.toThrow('代理客户端必须为 web 或 app');
  expect((await listSourceScripts())[0]).toMatchObject({
    proxyMode: false,
    appProxyMode: false,
  });
});
