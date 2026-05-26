/**
 * @resumagent/server 타입 shim.
 *
 * TUI 타입체크 컨텍스트에서 서버 파일(Bun 전용 API 포함)을 직접 포함하지 않도록
 * AppType만 ambient 선언으로 노출한다.
 * 실제 런타임에는 workspace 패키지(apps/server)가 사용된다.
 */

import type { Hono } from 'hono';

export type AppType = Hono;
