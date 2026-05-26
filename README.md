# resume-agent

Bun monorepo 기반 **AI 이력서 에이전트** — Hono RPC 백엔드, Web SPA, Ink TUI, WXT 크롬 익스텐션.

RAG 엔진은 [qmd](https://github.com/tobi/qmd) (bunx 실행, 별도 global 설치 불필요).

---

## 1) 설치

```bash
bun install
cp .env.example .env
```

`.env`에서 사용할 provider 환경변수를 설정하세요.

- Gemini: `GEMINI_API_KEY`
- Ollama: `OLLAMA_BASE_URL` (기본값 `http://localhost:11434`)

---

## 2) 개발 실행

### 백엔드 서버 (필수)

```bash
bun run --filter apps/server dev
# http://127.0.0.1:8080
```

> 외부 IP 접근은 차단됩니다 (127.0.0.1 only).

### Web SPA

```bash
bun run --filter apps/web dev
# http://localhost:5173
```

### TUI (터미널 UI)

```bash
bun run --filter apps/tui dev
```

### WXT 크롬 익스텐션

```bash
bun run --filter apps/extension dev
# Chrome → 확장 프로그램 → 개발자 모드 → 압축 해제된 확장 로드
# 경로: apps/extension/.output/chrome-mv3
```

### 전체 동시 실행

```bash
bun run --filter '*' dev
```

> TUI는 키 입력을 직접 점유하므로 동시 실행 시 입력이 깨질 수 있습니다.
> 서버를 먼저 띄운 뒤 TUI를 별도 터미널에서 실행하는 것을 권장합니다.

---

## 3) 빌드

```bash
bun install && bun run --filter '*' build
```

산출물:
- `apps/server/dist/` — Hono 서버 (Bun native)
- `apps/web/dist/` — 정적 SPA
- `apps/tui/dist/main.js` — Bun 번들 TUI
- `apps/extension/.output/chrome-mv3/` — MV3 익스텐션

---

## 4) Monorepo 구조

```
resume-agent/
├── apps/
│   ├── server/          Hono RPC 백엔드 (Bun, port 8080)
│   │   └── src/
│   │       ├── routes/  health / provider / rag / chat / form
│   │       └── services/ agent, providers (ollama/gemini), qmd
│   ├── web/             Vite + React 19 SPA (port 5173)
│   ├── tui/             Ink TUI (Bun 실행)
│   └── extension/       WXT MV3 크롬 익스텐션
│       └── entrypoints/ sidepanel / background / content
├── packages/
│   ├── shared/          Zod 스키마 + 공용 타입
│   ├── api-client/      Hono hc 타입 세이프 클라이언트
│   └── core/            (예약)
├── rag/                 RAG 대상 문서 폴더 (.md 파일 보관)
└── .env                 API 키 및 설정
```

---

## 5) 백엔드 API 엔드포인트

| Method | Path | 설명 |
|---|---|---|
| GET | `/health` | 헬스체크 |
| GET | `/provider/catalog` | 가용 LLM provider 목록 |
| GET | `/rag/status` | qmd 인덱스 상태 |
| POST | `/rag/reindex` | rag/ 폴더 재인덱싱 |
| GET | `/rag/search?q=...` | 시맨틱 검색 |
| POST | `/chat` | SSE 스트리밍 챗 |
| POST | `/form/suggest` | 폼 필드 자동완성 (익스텐션용) |

CORS: `chrome-extension://` 및 `http://localhost:*` 허용.

---

## 6) RAG (rag/ 폴더 기반)

`rag/` 폴더 안의 `.md` 파일을 qmd가 인덱싱합니다.

```bash
# 문서 추가 후 재인덱싱
curl -X POST http://127.0.0.1:8080/rag/reindex

# 검색 확인
curl "http://127.0.0.1:8080/rag/search?q=경력"
```

- qmd 실행: `bunx qmd` (global 설치 불필요)
- 인덱싱 경로: `RAG_DIR=./rag` (`.env`에서 변경 가능)
- `docs/` 폴더는 RAG 대상이 아님

자세한 내용: [`rag/README.md`](./rag/README.md)

---

## 7) WXT 익스텐션 — Form Fill

채용 사이트의 input 필드를 클릭하면:
1. content script가 label/aria-label/placeholder/heading 등 컨텍스트 수집
2. `/form/suggest` 로 전송 → qmd RAG + LLM 단답 생성
3. 필드에 자동 채움 (React controlled input 호환)

사이드패널에서 일반 챗도 가능합니다.
