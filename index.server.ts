import { createProvider } from './server/provider';
import { findDshCli } from './server/dsh-cli.mjs';
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
 * 双通道注册：
 *   dsh              —— WS mux 通道：历史全量快照 + 原生事件级（turn/step/job/inbox）
 *   dsh-acp          —— 手写 ACP 适配器（默认；快，plan/todo/图片/load，依赖 DSH_BASE/DSH_MUX）
 *   dsh-acp-official —— DSH 官方 `dsh --profile acp`（opt-in；permissions/MCP/session list+resume，
 *                       冷启动会拉模型列表，实测 30–90s）
 *
 * DSH_ACP_MODE=legacy（默认）| official | both
 */
export default function contribute(server: any) {
  if (process.env.DSH_DEBUG_PLUGIN) {
    console.error('[dsh] server keys:', Object.keys(server || {}));
    console.error('[dsh] ACP_SERVER:', ACP_SERVER);
  }
  server.registerProvider(createProvider());

  const mode = (process.env.DSH_ACP_MODE || 'legacy').toLowerCase();
  const dshCli = findDshCli();
  const profile = process.env.DSH_ACP_PROFILE || 'acp';
  const wantLegacy = mode !== 'official';
  const wantOfficial = mode === 'official' || mode === 'both';

  if (wantLegacy) {
    console.error('[dsh] ACP legacy adapter registered');
    server.registerProvider(
      runAcpProvider({
        id: 'dsh-acp',
        label: 'DSH (ACP)',
        icon: 'icon.svg',
        command: [process.execPath, ACP_SERVER],
      }),
    );
  }

  if (wantOfficial && dshCli) {
    console.error('[dsh] ACP official provider registered:', dshCli, '--profile', profile);
    server.registerProvider(
      runAcpProvider({
        id: 'dsh-acp-official',
        label: 'DSH (ACP official)',
        icon: 'icon.svg',
        command: [dshCli, '--profile', profile],
        // 官方 acp profile 启动时会拉模型列表（实测 30–90s），Paseo 默认 10s 会误判失败；
        // discovery 不建会话，避免每个 workspace 并发 session/new。
        acpOptions: {
          startupTimeoutMs: Number(process.env.DSH_ACP_STARTUP_MS) || 120_000,
          workspaceOnlyCatalog: true,
        },
      }),
    );
  } else if (wantOfficial) {
    console.error('[dsh] ACP official requested but dsh CLI not found (set DSH_CLI)');
  }

  return () => {};
}
