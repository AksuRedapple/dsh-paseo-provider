import { createProvider } from './server/provider';

/**
 * DSH 桌面版原生 provider（WS mux）。
 *
 * 只注册 WS 通道：从 DSH 桌面版的 web 日志发现端点与 cookie，消费
 * session/follow 持久流。ACP 变体保留在 tag v1.3.0 / 分支 acp-legacy。
 */
export default function contribute(server: any) {
  server.registerProvider(createProvider());
  return () => {};
}
