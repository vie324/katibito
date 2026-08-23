import { describe, expect, it } from "vitest";
import { analyzeSegment, analyzeTranscript } from "../src/engine/features";

describe("言語シグナル(付録A)", () => {
  it("文末言い切りを断定としてカウントする", () => {
    const c = analyzeSegment("結果は良好です。");
    expect(c.sentences).toBe(1);
    expect(c.assertions).toBe(1);
    expect(c.hedges).toBe(0);
  });

  it("文末のヘッジは断定として二重カウントしない", () => {
    const c = analyzeSegment("難しいと思います。");
    expect(c.hedges).toBe(1);
    expect(c.assertions).toBe(0);
  });

  it("「感じです」はヘッジであり断定ではない", () => {
    const c = analyzeSegment("そういう感じです。");
    expect(c.hedges).toBe(1);
    expect(c.assertions).toBe(0);
  });

  it("断定表現そのものが文末のときも二重カウントしない", () => {
    const c = analyzeSegment("移行を決めました。");
    expect(c.assertions).toBe(1);
  });

  it("文中の「ですね」は断定として拾わない(フィラー扱い)", () => {
    const c = analyzeSegment("そうですね、進めます。");
    expect(c.fillers).toBe(1);
    // 「進めます」の文末ます
    expect(c.assertions).toBe(1);
  });

  it("「ですね」で終わる文は言い切りではない", () => {
    const c = analyzeSegment("大変でしたね。");
    expect(c.assertions).toBe(0);
  });

  it("共有語: 前後が境界なら独立挿入 = フィラー", () => {
    const c = analyzeSegment("それは、まあ、良かったです。");
    expect(c.fillers).toBe(1);
    expect(c.hedges).toBe(0);
    expect(c.assertions).toBe(1);
  });

  it("共有語: 文頭から内容語に係るときは修飾 = ヘッジ", () => {
    const c = analyzeSegment("ちょっと難しいです。");
    expect(c.hedges).toBe(1);
    expect(c.fillers).toBe(0);
  });

  it("共有語: 判定困難(前が内容語)はフィラー側に倒す", () => {
    const c = analyzeSegment("それはまあ良かったです。");
    expect(c.fillers).toBe(1);
    expect(c.hedges).toBe(0);
  });

  it("「えーっと」は「えー」としてマッチする", () => {
    const c = analyzeSegment("えーっと今の話です。");
    expect(c.fillers).toBe(1);
  });

  it("感情語: 「大好き」を「好き」と二重カウントしない", () => {
    const c = analyzeSegment("この仕事が大好きです。");
    expect(c.emotionWords).toBe(1);
  });

  it("一人称と長いヘッジの内包関係", () => {
    const c = analyzeSegment("私は自分で決めました。うまくいったような気がします。");
    expect(c.sentences).toBe(2);
    expect(c.firstPerson).toBe(2);
    expect(c.assertions).toBe(1); // 決めました
    expect(c.hedges).toBe(1); // ような気がします(気がします と二重にしない)
  });

  it("句点なしの確定セグメントは1文として扱う", () => {
    const c = analyzeSegment("たぶんそうだったと思います");
    expect(c.sentences).toBe(1);
    expect(c.hedges).toBe(2); // たぶん + と思います
  });

  it("空白は文字数から除く", () => {
    const c = analyzeSegment("はい そうです。");
    expect(c.chars).toBe(7); // 「はいそうです。」
  });

  it("複数セグメントの合算", () => {
    const c = analyzeTranscript(["必ずやります。", "本当に嬉しい結果でした。"]);
    expect(c.sentences).toBe(2);
    expect(c.assertions).toBeGreaterThanOrEqual(2); // 必ず + でした(+ やります文末)
    expect(c.emotionWords).toBe(2); // 本当に + 嬉しい
  });
});
