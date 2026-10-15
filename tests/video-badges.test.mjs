import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function loadModule(path, globals = {}, dependencies = {}, suffix = '') {
  const context = vm.createContext({ console, ...globals });
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(source + suffix, { context });
  await module.link(specifier => {
    const values = dependencies[specifier];
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}

const badges = await loadModule('../lib/video-badges.js');
const plain = value => JSON.parse(JSON.stringify(value));

test('cards render labels as text for read and unread videos, and accept legacy entries', async () => {
  class Element {
    children = [];
    dataset = {};
    style = {};
    append(...children) { this.children.push(...children); }
    appendChild(child) { this.append(child); return child; }
    get childElementCount() { return this.children.length; }
    addEventListener() {}
    querySelectorAll() { return []; }
  }
  const popup = await loadModule('../popup/popup.js', {
    document: { createElement: () => new Element(), addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener() {} } } },
  }, {}, '\nexport { renderVideoCard };');
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const entry = { id: '1_test', mid: '1', bvid: 'test', title: 'Video', created: 1 };
  for (const is_read of [0, 1]) {
    const card = popup.renderVideoCard({ ...entry, is_read, video_badges: ['抢先看', '<b>充电专属</b>', null, ''] });
    const labels = flatten(card).filter(node => node.className === 'video-type-badge');
    assert.deepEqual(labels.map(node => node.textContent), ['抢先看', '<b>充电专属</b>']);
    assert.ok(labels.every(node => node.childElementCount === 0));
  }
  for (const video_badges of [undefined, [], 'invalid', [null, ' ']]) {
    const card = popup.renderVideoCard({ ...entry, video_badges });
    assert.ok(!flatten(card).some(node => node.className === 'video-type-badges'));
  }
});

test('API labels take precedence, with strict exclusive-flag fallback', () => {
  assert.deepEqual(plain(badges.getVideoBadges({ elec_arc_badge: { text: '抢先看' }, is_upower_exclusive: true })), ['抢先看']);
  assert.deepEqual(plain(badges.getVideoBadges({ is_upower_exclusive: true })), ['充电专属']);
  assert.deepEqual(plain(badges.getVideoBadges({ is_charging_union: 1 })), ['充电专属']);
  assert.deepEqual(plain(badges.getVideoBadges({ is_upower_exclusive: '0', is_charging_union: false })), []);
  assert.deepEqual(plain(badges.getVideoBadges({ elec_arc_badge: { text: '' } })), []);
  assert.deepEqual(plain(badges.getVideoBadges({})), []);
});

test('labels survive API mapping and reach storage, including the stopping anchor', async () => {
  const now = Math.floor(Date.now() / 1000);
  let requests = 0;
  const api = await loadModule('../lib/api.js', {
    fetch: async () => {
      requests++;
      return { status: 200, json: async () => ({ code: 0, data: { list: { vlist: [
        { bvid: 'new', created: now, elec_arc_badge: { text: '抢先看' } },
        { bvid: 'anchor', created: now - 3600, is_upower_exclusive: true },
      ] } } }) };
    },
  }, {
    './wbi.js': { encWbiSign: async () => 'signed' },
    './video-badges.js': { getVideoBadges: badges.getVideoBadges },
  });
  let saved;
  const monitor = await loadModule('../lib/update-monitor.js', {}, {
    './api.js': { fetchRecentVideos: api.fetchRecentVideos, randomDelay: async () => {} },
    './storage.js': {
      getTrackedUps: async () => [{ mid: '1', last_bvid: 'anchor', last_checked_at: (now - 100) * 1000 }],
      getSetting: async (_key, fallback) => fallback,
      setSetting: async () => {},
      persistUpdateCheckResult: async (...args) => { saved = args; return true; },
    },
  });
  assert.equal(await monitor.checkAllUpdates(), 1);
  assert.equal(requests, 1);
  assert.deepEqual(plain(saved[2][0].video_badges), ['抢先看']);
  assert.deepEqual(plain(saved[4]), [
    { id: '1_new', video_badges: ['抢先看'] },
    { id: '1_anchor', video_badges: ['充电专属'] },
  ]);
});

test('metadata refresh preserves read state and never recreates deleted updates', async () => {
  const stores = {
    tracking: new Map([['1', { mid: '1' }]]),
    updates: new Map([['1_anchor', { id: '1_anchor', mid: '1', is_read: 1, discovered_at: 123 }]]),
  };
  const db = {
    transaction() {
      const tx = {
        objectStore(name) {
          return {
            get(key) {
              const req = {};
              queueMicrotask(() => {
                req.result = structuredClone(stores[name].get(key));
                req.onsuccess?.();
              });
              return req;
            },
            put(value) { stores[name].set(value.id || value.mid, structuredClone(value)); },
          };
        },
      };
      setImmediate(() => tx.oncomplete?.());
      return tx;
    },
  };
  const storage = await loadModule('../lib/storage.js', {
    indexedDB: {
      open() {
        const req = {};
        queueMicrotask(() => req.onsuccess({ target: { result: db } }));
        return req;
      },
    },
  });
  await storage.persistUpdateCheckResult('1', 'anchor', [], Date.now(), [
    { id: '1_anchor', video_badges: ['抢先看'] },
    { id: '1_deleted', video_badges: ['充电专属'] },
  ]);
  assert.equal(stores.updates.size, 1);
  assert.equal(stores.updates.get('1_anchor').is_read, 1);
  assert.equal(stores.updates.get('1_anchor').discovered_at, 123);
  assert.deepEqual(plain(stores.updates.get('1_anchor').video_badges), ['抢先看']);
  await storage.persistUpdateCheckResult('1', 'anchor', [], Date.now(), [
    { id: '1_anchor', video_badges: [] },
  ]);
  assert.deepEqual(plain(stores.updates.get('1_anchor').video_badges), []);
  assert.equal(stores.updates.get('1_anchor').is_read, 1);
});
