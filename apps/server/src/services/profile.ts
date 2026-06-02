import { join } from "path";
import { readdir } from "fs/promises";
import { env } from "../config/env.js";
import { queryRag } from "./qmd.ts";

export async function searchProfileContent(query: string): Promise<string> {
  const result = await queryRag(query);
  if (result) return result;

  try {
    const files = await readdir(env.RAG_DIR);
    const mdFiles = files.filter((f) => f.endsWith(".md"));
    if (mdFiles.length === 0) return "저장된 프로필 정보가 없습니다.";

    const contents = await Promise.all(
      mdFiles.map(async (f) => {
        const text = await Bun.file(join(env.RAG_DIR, f))
          .text()
          .catch(() => "");
        return text ? `## ${f}\n${text}` : null;
      })
    );
    return contents.filter(Boolean).join("\n\n---\n\n") || "저장된 프로필 정보가 없습니다.";
  } catch {
    return "RAG 폴더를 읽을 수 없습니다.";
  }
}
