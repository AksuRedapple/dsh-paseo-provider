/**
 * dsh-provider 结构化日志（2026-11-10）
 *
 * 之前插件日志全是 console.error 的自由文本：回合失败时只有一行
 * `prompt <session> chars N blocks N`，线上排障只能靠「Paseo 的失败时间戳
 * 和 DSH 进程重启时间对齐」猜根因（2026-11-07~09 的 7 次失败就是这么查的）。
 *
 * 现在统一成：`[dsh] <event> key=value ...`
 *   · 一行一条，key=value 可 grep / 可 awk
 *   · 级别用 DSH_LOG_LEVEL 控制（debug|info|warn|error，默认 info）
 *   · 绝不打印 prompt 正文、token、cookie（只打形状和计数）
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const raw = String(process.env.DSH_LOG_LEVEL || 'info').toLowerCase();
  return RANK[raw as LogLevel] ?? RANK.info;
}

/** 值渲染：数字/布尔裸写，字符串有空白或引号/等号时加双引号，保证 key=value 可解析。 */
function render(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (RANK[level] < threshold()) return;
  const parts = [`[dsh] ${event}`];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${key}=${render(value)}`);
  }
  // 统一走 stderr：Paseo 的插件输出两路都收，单流才好按时间排序
  console.error(parts.join(' '));
}

export const logDebug = (event: string, fields?: Record<string, unknown>) => log('debug', event, fields);
export const logInfo = (event: string, fields?: Record<string, unknown>) => log('info', event, fields);
export const logWarn = (event: string, fields?: Record<string, unknown>) => log('warn', event, fields);
export const logError = (event: string, fields?: Record<string, unknown>) => log('error', event, fields);
