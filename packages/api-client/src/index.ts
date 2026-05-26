import { hc } from "hono/client";
import type { AppType } from "@resumagent/server";

export { hc };
export type { AppType };

/**
 * 백엔드 hc 클라이언트 팩토리.
 * baseUrl 기본값은 로컬 서버.
 */
export function createClient(baseUrl = "http://127.0.0.1:8080") {
  return hc<AppType>(baseUrl);
}
