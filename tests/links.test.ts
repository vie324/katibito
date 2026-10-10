// メモの中のリンクの判定: このアプリの中へのリンクだけを押せるようにする。

import { describe, expect, it } from "vitest";
import { internalPath } from "../src/app/links";

describe("internalPath", () => {
  const origin = "https://interview.example.jp";
  it("同じサイトの場面へのリンクは、パスとクエリを返す", () => {
    expect(internalPath(`${origin}/interviews/abc?rec=r1&t=95`, origin)).toBe("/interviews/abc?rec=r1&t=95");
  });
  it("外部のサイトや、パスが // で始まる(ブラウザでは外部になる)リンクは認めない", () => {
    expect(internalPath("https://evil.example/interviews/abc", origin)).toBeNull();
    expect(internalPath(`${origin}//evil.example/login?t=95`, origin)).toBeNull();
    expect(internalPath(`${origin}/\\evil.example/login`, origin)).toBeNull();
    expect(internalPath("not a url", origin)).toBeNull();
  });
});
