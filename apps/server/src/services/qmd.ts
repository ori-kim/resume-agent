import { env } from "../config/env.ts";

/**
 * qmd CLI wrapper using Bun.spawn.
 * qmd는 bunx qmd 형태로 실행 (npm global 불필요).
 */

function runQmd(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["bunx", "qmd", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, exitCode]) => ({ stdout, stderr, exitCode }));
}

/**
 * RAG_DIR 경로를 qmd collection으로 등록하고 인덱싱한다.
 */
export async function indexRag({ embed = false } = {}): Promise<void> {
  // 컬렉션이 없으면 생성, 있으면 update로 재인덱싱
  const listResult = await runQmd(["collection", "list"]);
  const exists = listResult.stdout.includes("rag");

  if (!exists) {
    const addResult = await runQmd([
      "collection", "add", env.RAG_DIR, "--name", "rag", "--mask", "*.md",
    ]);
    if (addResult.exitCode !== 0) {
      console.error("[qmd] collection add stderr:", addResult.stderr);
      throw new Error(`qmd collection add failed (exit ${addResult.exitCode})`);
    }
    console.log("[qmd] collection created:", addResult.stdout.trim());
  } else {
    const updateResult = await runQmd(["update", "rag"]);
    if (updateResult.exitCode !== 0) {
      console.warn("[qmd] update warning:", updateResult.stderr.trim());
    }
    console.log("[qmd] collection updated");
  }

  if (embed) {
    const embedResult = await runQmd(["embed"]);
    if (embedResult.exitCode !== 0) {
      console.warn("[qmd] embed warning:", embedResult.stderr.trim());
    } else {
      console.log("[qmd] embed done");
    }
  }
}

/**
 * qmd query로 상위 파일 URI 목록을 얻고, qmd get으로 실제 내용을 반환한다.
 * LLM에게 깨끗한 마크다운 컨텍스트를 주입하기 위해 diff 형식 출력을 피한다.
 */
export async function queryRag(query: string): Promise<string> {
  // 1단계: 상위 매칭 파일 URI 목록 가져오기
  const filesResult = await runQmd(["query", query, "-c", "rag", "--files"]);
  if (filesResult.exitCode !== 0 || !filesResult.stdout.trim()) return "";

  // "#hash,score,qmd://..." 형식에서 URI 추출, 상위 2개
  const uris = filesResult.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.includes("qmd://rag/"))
    .slice(0, 2)
    .map((l) => l.split(",").at(-1)?.trim() ?? "")
    .filter(Boolean);

  if (uris.length === 0) return "";

  // 2단계: 각 파일의 전체 내용 가져오기
  const contents = await Promise.all(
    uris.map(async (uri) => {
      const r = await runQmd(["get", uri]);
      return r.exitCode === 0 ? r.stdout.trim() : "";
    })
  );

  return contents.filter(Boolean).join("\n\n---\n\n");
}

/**
 * qmd status 반환.
 */
export async function statusRag(): Promise<string> {
  const result = await runQmd(["status"]);
  return result.stdout.trim();
}

/**
 * 서버 시작 시 한 번 POC 실행 (인덱싱 + 쿼리).
 * 결과를 콘솔에만 출력한다.
 */
export async function runPoc(): Promise<void> {
  console.log("[qmd-poc] indexing", env.RAG_DIR);
  await indexRag();
  console.log("[qmd-poc] querying...");
  const result = await queryRag("test");
  console.log("[qmd-poc] query result:", result || "(empty)");
}
