import { createProvider } from './server/provider';
import { runAcpProvider } from '@getpaseo/plugin/server/acp';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function paseoPluginDir(): string | undefined {
  try {
    const home = process.env.PASEO_HOME || path.join(os.homedir(), '.paseo');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    const entry = cfg?.plugins?.['dsh-provider'];
    if (entry?.path) return String(entry.path);
  } catch {}
  return undefined;
}

/** Paseo 的插件加载器不保证 import.meta.url 可用（打包后曾报 Invalid URL）。
 *  优先级：显式环境变量 → import.meta → Paseo 配置里的插件目录 → 已知目录变量 → 相对路径。 */
function resolveAcpServer(): string {
  const explicit = process.env.DSH_ACP_SERVER;
  if (explicit) return explicit;
  try {
    const url = (import.meta as any)?.url;
    if (url && String(url).startsWith('file:')) {
      return fileURLToPath(new URL('./acp-server.mjs', url));
    }
  } catch {}
  const pluginDir = paseoPluginDir();
  if (pluginDir) return `${pluginDir.replace(/\/$/, '')}/acp-server.mjs`;
  const dir = process.env.DSH_PLUGIN_DIR || process.env.PASEO_PLUGIN_DIR;
  if (dir) return `${dir.replace(/\/$/, '')}/acp-server.mjs`;
  return 'acp-server.mjs';
}

const ACP_SERVER = resolveAcpServer();

/**
 * 双模式注册（2026-11-02 用户要求保留两种）：
 *   dsh      —— WS mux 通道：历史全量快照 + 原生事件级（turn/step/job/inbox）
 *   dsh-acp  —— ACP 标准通道：协议稳定、审批语义正确；底层由 acp-server.mjs 包一层
 */
export default function contribute(server: any) {
  if (process.env.DSH_DEBUG_PLUGIN) {
    console.error('[dsh] server keys:', Object.keys(server || {}));
    console.error('[dsh] ACP_SERVER:', ACP_SERVER);
  }
  server.registerProvider(createProvider());

  server.registerProvider(
    runAcpProvider({
      id: 'dsh-acp',
      label: 'DSH (ACP)',
      icon: 'icon.svg',
      command: [process.execPath, ACP_SERVER],
    }),
  );

  return () => {};
}
