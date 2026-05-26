import { env } from "./config/env.ts";
import { app } from "./app.ts";
import { runPoc } from "./services/qmd.ts";

console.log(`[server] starting on ${env.HOST}:${env.PORT}`);

// qmd POC: 서버 시작 시 한 번 실행
runPoc().catch((err) => {
  console.warn("[qmd-poc] failed (non-fatal):", err.message);
});

export default {
  port: env.PORT,
  hostname: env.HOST,
  fetch: app.fetch,
  idleTimeout: 0,
};
