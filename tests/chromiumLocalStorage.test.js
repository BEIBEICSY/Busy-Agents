import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChromiumLocalStorage } from '../src/server/chromiumLocalStorage.js';
import { buildWorkBuddySession, loadWorkBuddyViewState } from '../src/server/workBuddySessionScanner.js';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = (name = 'state') => path.join(fixtures, `workbuddy-view-${name}`);
const keys = ['codebuddy-read-conversations', 'codebuddy-unread-completed'];

test('native LevelDB tables and newer WAL recover exact read/unread sets across encodings', () => {
  const view = loadWorkBuddyViewState({ levelDbPath: fixture() });
  assert.equal(view.loaded, true);
  assert.deepEqual([...view.readIds], ['seen-a', 'becomes-seen', '中文会话']);
  assert.deepEqual([...view.unreadIds], ['unread-a']);
  assert.equal(buildWorkBuddySession({ id: 'becomes-seen', status: 'completed' }, view).status, 'completed_seen');
  assert.equal(buildWorkBuddySession({ id: 'unread-a', status: 'completed' }, view).status, 'completed_unseen');
  assert.equal(buildWorkBuddySession({ id: 'historical', status: 'completed' }, view).status, 'unknown');
});

test('Snappy-compressed table evidence is recovered without mistaking another origin for this app', () => {
  const result = readChromiumLocalStorage(fixture(), keys, {
    readdirSync: (directory) => fs.readdirSync(directory).filter((file) => !file.endsWith('.log'))
  });
  assert.equal(result.available, true);
  const readIds = JSON.parse(result.values.get(keys[0]));
  assert.equal(readIds.length, 401);
  assert.equal(readIds.includes('seen-a'), true);
  assert.equal(readIds.includes('wrong-origin'), false);
});

test('explicit origins and key prefixes select only matching local storage values', () => {
  const result = readChromiumLocalStorage(fixture(), [], {
    origins: ['file://'],
    keyPrefixes: ['codebuddy-read-']
  });

  assert.equal(result.available, true);
  assert.deepEqual([...result.values.keys()], ['codebuddy-read-conversations']);
});

test('latest tombstones and empty lists supersede older table entries, regardless of file order', () => {
  const view = loadWorkBuddyViewState({
    levelDbPath: fixture('deleted'),
    readdirSync: (directory) => fs.readdirSync(directory).reverse()
  });
  assert.equal(view.loaded, true);
  assert.equal(view.readLoaded, false);
  assert.equal(view.unreadLoaded, true);
  assert.equal(view.readIds.size, 0);
  assert.equal(view.unreadIds.size, 0);
  assert.equal(buildWorkBuddySession({ id: 'seen-a', status: 'completed' }, view).status, 'unknown');
});

test('fragmented native WAL writes and an incomplete live tail preserve committed evidence', () => {
  const view = loadWorkBuddyViewState({
    levelDbPath: fixture('fragmented'),
    readFileSync: (file) => {
      const data = fs.readFileSync(file);
      return file.endsWith('.log') ? Buffer.concat([data, Buffer.from([0, 0, 0])]) : data;
    }
  });
  assert.equal(view.readIds.size, 1500);
  assert.equal(view.readIds.has('fragmented-session-01499'), true);
});

test('corrupt WAL, missing live tables and unsupported snapshots safely withhold read claims', () => {
  for (const change of ['checksum', 'missing-table', 'manifest']) {
    const view = loadWorkBuddyViewState({
      levelDbPath: fixture(),
      readFileSync: (file) => {
        if (change === 'missing-table' && file.endsWith('.ldb')) throw new Error('Compaction race');
        const data = fs.readFileSync(file);
        if ((change === 'checksum' && file.endsWith('.log')) || (change === 'manifest' && path.basename(file).startsWith('MANIFEST'))) {
          const broken = Buffer.from(data);
          broken[10] ^= 255;
          return broken;
        }
        return data;
      }
    });
    assert.equal(view.loaded, false, change);
    assert.equal(view.readIds.size, 0, change);
    assert.equal(view.unreadIds.size, 0, change);
  }
});

test('obsolete files and nearby JSON cannot fabricate evidence when the native DB is unavailable', () => {
  const view = loadWorkBuddyViewState({
    levelDbPath: fixture(),
    readdirSync: (directory) => [...fs.readdirSync(directory), '999999.ldb'],
    readFileSync: (file) => {
      if (file.endsWith('999999.ldb')) throw new Error('Obsolete file must never be read');
      return fs.readFileSync(file);
    }
  });
  assert.equal(view.readIds.has('becomes-seen'), true);
  const unavailable = loadWorkBuddyViewState({
    levelDbPath: '/missing', readFileSync: () => Buffer.from('codebuddy-read-conversations ["fake"]')
  });
  assert.equal(unavailable.loaded, false);
  assert.equal(unavailable.readIds.size, 0);
});
