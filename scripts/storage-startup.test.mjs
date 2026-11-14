import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');

function fixture(mode) {
  const directory = mkdtempSync(resolve(tmpdir(), 'moontv-storage-test-'));
  const keys = [
    'NEXT_PUBLIC_STORAGE_TYPE',
    'SQLITE_DB_PATH',
    'CF_PAGES',
    'BUILD_TARGET',
    'USERNAME',
    'PASSWORD',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]])
  );
  process.env.NEXT_PUBLIC_STORAGE_TYPE = mode;
  process.env.SQLITE_DB_PATH = resolve(directory, 'moontv.db');
  process.env.USERNAME = 'startup-test';
  process.env.PASSWORD = 'startup-test-only';
  delete process.env.CF_PAGES;
  delete process.env.BUILD_TARGET;
  const connections = [];
  let modules = new Map();

  function load(filename) {
    const absolute = resolve(root, filename);
    if (modules.has(absolute)) return modules.get(absolute).exports;
    const module = { exports: {} };
    modules.set(absolute, module);
    const { outputText } = ts.transpileModule(readFileSync(absolute, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const external = createRequire(absolute);
    function dependency(id) {
      // These services are unrelated to registry persistence and would import
      // notification transports. Database/SQLite/registry code stays real.
      if (id === './notification-dispatch')
        return {
          dispatchNotificationChannels() {
            throw new Error('Unexpected notification');
          },
        };
      if (id === './user-cache') return { userInfoCache: {} };
      if (id === 'better-sqlite3') {
        const Database = external(id);
        return function (...args) {
          const connection = new Database(...args);
          connections.push(connection);
          return connection;
        };
      }
      if (id.startsWith('@/')) return load(`src/${id.slice(2)}.ts`);
      if (id.startsWith('.'))
        return load(resolve(dirname(absolute), `${id}.ts`));
      return external(id);
    }
    new Function('exports', 'require', 'module', outputText)(
      module.exports,
      dependency,
      module
    );
    return module.exports;
  }

  function closeConnections() {
    for (const connection of connections.splice(0)) connection.close();
  }
  return {
    load,
    initialize() {
      require(resolve(root, 'scripts/init-sqlite.js')).initSQLiteDatabase();
    },
    restart() {
      closeConnections();
      modules = new Map();
    },
    dispose() {
      closeConnections();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('browser-only storage can load the public-page source registry without a database', async () => {
  const app = fixture('localstorage');
  try {
    const { db } = app.load('src/lib/db.ts');
    assert.equal(await db.getGlobalValue('source-script:registry'), null);
    const scripts = app.load('src/lib/source-script.ts');
    assert.deepEqual(await scripts.listEnabledSourceScripts(), []);
    assert.deepEqual(await scripts.listSourceScripts(), []);
  } finally {
    app.dispose();
  }
});

test('browser-only storage rejects global writes explicitly instead of reporting persistence', async () => {
  const app = fixture('localstorage');
  try {
    const { db } = app.load('src/lib/db.ts');
    await assert.rejects(db.setGlobalValue('key', 'value'), /启用服务端存储/);
    await assert.rejects(db.deleteGlobalValue('key'), /启用服务端存储/);
  } finally {
    app.dispose();
  }
});

test('the Docker default initializes real SQLite and persists source scripts across restarts', async () => {
  const runner = readFileSync(resolve(root, 'Dockerfile'), 'utf8').split(
    'FROM base AS runner'
  )[1];
  const mode = runner.match(/^ENV NEXT_PUBLIC_STORAGE_TYPE=(\S+)$/m)?.[1];
  assert(mode, 'The image needs an explicit supported default storage mode');
  const app = fixture(mode);
  try {
    app.initialize();
    const { db } = app.load('src/lib/db.ts');
    assert.equal(await db.getGlobalValue('missing'), null);
    await db.setGlobalValue('test', 'persisted');
    assert.equal(await db.getGlobalValue('test'), 'persisted');
    await db.deleteGlobalValue('test');
    assert.equal(await db.getGlobalValue('test'), null);

    const scripts = app.load('src/lib/source-script.ts');
    assert.deepEqual(await scripts.listEnabledSourceScripts(), []);
    const saved = await scripts.saveSourceScript({
      key: 'startup-test',
      name: 'Startup source',
      code: 'return { meta: { name: "Startup source" } };',
    });
    assert.equal(
      (await scripts.listEnabledSourceScripts())[0].key,
      'startup-test'
    );

    app.restart();
    const restarted = app.load('src/lib/source-script.ts');
    const stored = await restarted.listSourceScripts();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].id, saved.id);
    assert.equal(stored[0].code, saved.code);
  } finally {
    app.dispose();
  }
});
