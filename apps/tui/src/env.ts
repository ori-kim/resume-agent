/**
 * TUI 환경 설정.
 * 서버 주소는 SERVER_URL 환경 변수 또는 기본값 사용.
 */
export const resolvedServerUrl =
  process.env["SERVER_URL"] ?? "http://127.0.0.1:8080";
