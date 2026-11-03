import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 候选路径（按优先级）：显式 DSH_CLI → 桌面版内置 CLI → 平台常见安装位置。 */
export function dshCliCandidates({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const out = [];
  if (env.DSH_CLI) out.push(env.DSH_CLI);
  if (platform === 'darwin') {
    out.push('/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh');
    out.push(path.join(home, 'Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'));
  } else if (platform === 'win32') {
    if (env.LOCALAPPDATA) {
      out.push(path.join(env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
    if (env.ProgramFiles) {
      out.push(path.join(env.ProgramFiles, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));
    }
  } else {
    out.push('/opt/DeepSeek Harness/resources/runtime/cli/bin/dsh');
    out.push(path.join(home, '.local', 'share', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh'));
  }
  return out;
}

function defaultWhich(name) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(probe, [name], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return undefined;
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
}

/** 找 dsh CLI：候选路径存在 → PATH 上的 dsh。找不到返回 undefined。 */
export function findDshCli({
  exists = fs.existsSync,
  which = defaultWhich,
  ...opts
} = {}) {
  for (const p of dshCliCandidates(opts)) {
    try {
      if (p && exists(p)) return p;
    } catch {}
  }
  try {
    return which('dsh');
  } catch {
    return undefined;
  }
}
