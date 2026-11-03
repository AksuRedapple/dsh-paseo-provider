import test from 'node:test';
import assert from 'node:assert/strict';
import { dshCliCandidates, findDshCli } from '../../server/dsh-cli.mjs';

test('cli-1: 候选顺序 = DSH_CLI → 桌面版内置 → 平台路径', () => {
  const mac = dshCliCandidates({
    platform: 'darwin',
    env: { DSH_CLI: '/custom/dsh' },
    home: '/Volumes/Data/me',
  });
  assert.equal(mac[0], '/custom/dsh');
  assert.equal(mac[1], '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
  assert.ok(mac[2].endsWith('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'));

  const win = dshCliCandidates({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    home: 'C:\\Users\\me',
  });
  assert.ok(win.some((p) => p.includes('Programs') && p.endsWith('dsh.cmd')));

  const linux = dshCliCandidates({ platform: 'linux', env: {}, home: '/home/me' });
  assert.ok(linux.includes('/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh'));
});

test('cli-2: 优先返回第一个存在的候选，其次 PATH', () => {
  const found = findDshCli({
    platform: 'darwin',
    env: { DSH_CLI: '/a/dsh' },
    home: '/Volumes/Data/me',
    exists: (p) => p === '/a/dsh',
    which: () => '/usr/local/bin/dsh',
  });
  assert.equal(found, '/a/dsh');

  const fromPath = findDshCli({
    platform: 'darwin',
    env: {},
    home: '/Volumes/Data/me',
    exists: () => false,
    which: () => '/usr/local/bin/dsh',
  });
  assert.equal(fromPath, '/usr/local/bin/dsh');
});

test('cli-3: 都找不到时返回 undefined；exists 抛错不致命', () => {
  const none = findDshCli({
    platform: 'darwin',
    env: {},
    home: '/Volumes/Data/me',
    exists: () => false,
    which: () => undefined,
  });
  assert.equal(none, undefined);

  const throwing = findDshCli({
    platform: 'darwin',
    env: {},
    home: '/Volumes/Data/me',
    exists: () => { throw new Error('EACCES'); },
    which: () => undefined,
  });
  assert.equal(throwing, undefined);
});
