import { describe, expect, it } from "vitest";
import { clip } from "../src/util/text.js";

describe("clip", () => {
  it("does not send half an emoji when the size limit falls inside a surrogate pair", () => {
    expect(clip("Python 🐍 jobs", 9)).toBe("Python …");
    expect(clip("Python 🐍 jobs", 10)).toBe("Python 🐍…");
  });

  it("repairs lone surrogates already present in extracted page text", () => {
    expect(clip("a\ud83db\udc00c", 20)).toBe("a�b�c");
    expect(clip("🇨🇱 Python 🐍", 30)).toBe("🇨🇱 Python 🐍");
  });

  it("retains the existing size budget and ellipsis behavior", () => {
    expect(clip("hello", 0)).toBe("");
    expect(clip("hello", 1)).toBe("…");
    expect(clip("hello", 4)).toBe("hel…");
    expect(clip("hello", 5)).toBe("hello");
  });
});
