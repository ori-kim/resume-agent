import { describe, expect, test } from "bun:test";
import { getAcceptedImageFiles } from "./imageAttachments";

function file(name: string, type: string, size = 100): File {
  return new File(["x".repeat(size)], name, { type });
}

describe("getAcceptedImageFiles", () => {
  test("keeps only image files", () => {
    const accepted = getAcceptedImageFiles([
      file("screen.png", "image/png"),
      file("notes.txt", "text/plain"),
      file("photo.jpg", "image/jpeg"),
    ]);

    expect(accepted.map((f) => f.name)).toEqual(["screen.png", "photo.jpg"]);
  });

  test("limits appended files to the configured maximum", () => {
    const accepted = getAcceptedImageFiles(
      [file("a.png", "image/png"), file("b.png", "image/png"), file("c.png", "image/png")],
      { existingCount: 1, maxFiles: 2 }
    );

    expect(accepted.map((f) => f.name)).toEqual(["a.png"]);
  });

  test("rejects oversized image files", () => {
    const accepted = getAcceptedImageFiles(
      [file("small.png", "image/png", 4), file("large.png", "image/png", 10)],
      { maxBytes: 5 }
    );

    expect(accepted.map((f) => f.name)).toEqual(["small.png"]);
  });
});
