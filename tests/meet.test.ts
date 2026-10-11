// オンライン面接(Google Meet)の結合テスト: Meet のリンクの検証、面接の形式、口頭の同意、画面の共有で録った録画、予定(.ics)。

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildIcs, interviewEvent } from "../src/app/ics";
import { normalizeMeetUrl, placeLabel } from "../src/shared/meet";
import type { InterviewDetail, InterviewListItem } from "../src/shared/types";
import { Client, fromDevice, newInterview, readyRecording, setupTeam, startServer, WEBM, type TestServer } from "./helpers/http";

describe("normalizeMeetUrl", () => {
  it("Meet のリンクの書き方の違いをそろえる", () => {
    const u = "https://meet.google.com/abc-defg-hij";
    expect(normalizeMeetUrl(u)).toBe(u);
    expect(normalizeMeetUrl("  meet.google.com/abc-defg-hij  ")).toBe(u);
    expect(normalizeMeetUrl("abc-defg-hij")).toBe(u);
    expect(normalizeMeetUrl("ABC-DEFG-HIJ")).toBe(u);
    expect(normalizeMeetUrl("http://meet.google.com/abc-defg-hij")).toBe(u);
    // 開いた人のアカウントの番号などのクエリは除く
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij?authuser=1&hs=122#x")).toBe(u);
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij/")).toBe(u);
    expect(normalizeMeetUrl("https://meet.google.com/_meet/abc-defg-hij")).toBe(u);
    expect(normalizeMeetUrl("https://meet.google.com/lookup/interview_2026")).toBe("https://meet.google.com/lookup/interview_2026");
  });

  it("Meet 以外のリンク・形の違うものは受け付けない", () => {
    for (const bad of [
      "",
      "https://meet.google.com/",
      "https://meet.google.com/abc-defg",
      "https://meet.google.com/abcdefghij",
      "https://meet.google.com.evil.example/abc-defg-hij",
      "https://evil.example/meet.google.com/abc-defg-hij",
      "https://user:pw@meet.google.com/abc-defg-hij",
      "https://meet.google.com:8443/abc-defg-hij",
      "javascript:alert(1)//meet.google.com/abc-defg-hij",
      "ftp://meet.google.com/abc-defg-hij",
      "https://meet.google.com/lookup/../../evil",
      "https://zoom.us/j/123456789",
    ]) {
      expect(normalizeMeetUrl(bad), bad).toBeNull();
    }
  });

  it("オンライン面接で場所が空なら「オンライン(Google Meet)」と表示する", () => {
    expect(placeLabel({ location: "", format: "online" })).toBe("オンライン(Google Meet)");
    expect(placeLabel({ location: "本校 2F", format: "online" })).toBe("本校 2F");
    expect(placeLabel({ location: "", format: "inPerson" })).toBe("");
  });
});

describe("予定(.ics)", () => {
  it("オンライン面接は、場所と説明に Meet のリンクを入れる", () => {
    const ev = interviewEvent(
      {
        id: "iv1",
        scheduledAt: "2026-10-20T07:00:00.000Z",
        plannedMinutes: 20,
        round: "一次面接",
        location: "",
        format: "online",
        meetUrl: "https://meet.google.com/abc-defg-hij",
        candidate: { displayName: "佐藤 花" },
      },
      { orgName: "テスト塾", interviewerNames: ["面接官A"], origin: "https://interview.example.jp" },
    )!;
    expect(ev.location).toBe("https://meet.google.com/abc-defg-hij");
    expect(ev.summary).toBe("面接: 佐藤 花(一次面接)[オンライン]");
    expect(ev.description.split("\n")[0]).toBe("Google Meet: https://meet.google.com/abc-defg-hij");
    expect(ev.url).toBe("https://interview.example.jp/interviews/iv1");
    const lines = buildIcs([ev], "面接の予定").replace(/\r\n /g, "").split("\r\n");
    expect(lines).toContain("LOCATION:https://meet.google.com/abc-defg-hij");
  });
});

describe("オンライン面接(サーバー)", () => {
  let server: TestServer;
  let admin: Client;
  let alice: Client;
  let ids: Record<string, string>;

  beforeAll(async () => {
    server = await startServer();
    ({ admin, alice, ids } = await setupTeam(server));
  });
  afterAll(async () => {
    await server.close();
  });

  const create = (body: Record<string, unknown>) =>
    admin.req("POST", "/api/interviews", { candidate: { displayName: "Meet の人" }, interviewerIds: [ids.alice], ...body });

  it("Meet のリンクを付けて登録でき、形式を省くとオンラインになる。Meet 以外のリンクは受け付けない", async () => {
    const r = await create({ meetUrl: "meet.google.com/abc-defg-hij?authuser=0" });
    expect(r.status).toBe(200);
    const iv = (r.json as InterviewDetail).interview;
    expect(iv.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
    expect(iv.format).toBe("online");
    // 対面の面接に、同席する人のための Meet のリンクを付けることもできる
    const inPerson = (await create({ format: "inPerson", meetUrl: "abc-defg-hij" })).json as InterviewDetail;
    expect(inPerson.interview.format).toBe("inPerson");
    expect(inPerson.interview.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
    // 形式もリンクもなければ対面
    const plain = (await create({})).json as InterviewDetail;
    expect(plain.interview.format).toBe("inPerson");
    expect(plain.interview.meetUrl).toBeNull();

    const bad = await create({ meetUrl: "https://evil.example/abc-defg-hij" });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("Google Meet");
    expect((await create({ format: "zoom" })).status).toBe(400);

    // 一覧の項目にも形式とリンクが付く
    const list = (await alice.req("GET", "/api/interviews")).json.interviews as InterviewListItem[];
    const item = list.find((x) => x.id === iv.id)!;
    expect(item.format).toBe("online");
    expect(item.meetUrl).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("あとから形式とリンクを変えられ、空にするとリンクを外せる", async () => {
    const iid = ((await create({})).json as InterviewDetail).interview.id;
    let d = (await alice.req("PATCH", `/api/interviews/${iid}`, { format: "online", meetUrl: "https://meet.google.com/xyz-abcd-efg" })).json as InterviewDetail;
    expect(d.interview.format).toBe("online");
    expect(d.interview.meetUrl).toBe("https://meet.google.com/xyz-abcd-efg");
    expect((await alice.req("PATCH", `/api/interviews/${iid}`, { meetUrl: "not a link" })).status).toBe(400);
    d = (await alice.req("PATCH", `/api/interviews/${iid}`, { meetUrl: "" })).json as InterviewDetail;
    expect(d.interview.meetUrl).toBeNull();
    expect(d.interview.format).toBe("online");
  });

  it("まとめて登録でも形式と Meet のリンクを入れられる(誤りがあれば何も登録しない)", async () => {
    const ok = await admin.req("POST", "/api/interviews/bulk", {
      rows: [
        { candidate: { displayName: "一括 Meet" }, meetUrl: "https://meet.google.com/aaa-bbbb-ccc", interviewerIds: [] },
        { candidate: { displayName: "一括 対面" }, format: "inPerson", interviewerIds: [] },
      ],
    });
    expect(ok.status).toBe(200);
    const [a, b] = ok.json.ids as string[];
    expect(server.app.ctx.store.interviews.get(a)!.format).toBe("online");
    expect(server.app.ctx.store.interviews.get(b)!.format).toBe("inPerson");
    const bad = await admin.req("POST", "/api/interviews/bulk", {
      rows: [{ candidate: { displayName: "x" }, interviewerIds: [] }, { candidate: { displayName: "y" }, meetUrl: "https://zoom.us/j/1", interviewerIds: [] }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain("2行目");
  });

  it("口頭での同意は、オンライン面接のときだけ記録できる", async () => {
    const consent = {
      recording: true,
      analysis: true,
      candidateName: "Meet の人",
      method: "verbal",
      consentText: "同意文(オンライン面接で読み上げ)",
    };
    const inPerson = ((await create({})).json as InterviewDetail).interview.id;
    const r1 = await alice.req("POST", `/api/interviews/${inPerson}/consent`, consent);
    expect(r1.status).toBe(400);
    expect(r1.json.error).toContain("オンライン面接");

    const online = ((await create({ format: "online" })).json as InterviewDetail).interview.id;
    const r2 = await alice.req("POST", `/api/interviews/${online}/consent`, consent);
    expect(r2.status).toBe(200);
    expect((r2.json as InterviewDetail).interview.consent!.method).toBe("verbal");
  });

  it("Meet のチャットで送ったリンク(面接の最中)への回答は、面接の場での同意として扱う", async () => {
    const pub = new Client(() => server.base);
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const answer = async (purpose: "advance" | "meeting") => {
      const iid = ((await create({ format: "online", scheduledAt: future })).json as InterviewDetail).interview.id;
      const l = await alice.req("POST", `/api/interviews/${iid}/consent-links`, { days: 1, purpose });
      expect(l.status).toBe(200);
      const info = (await pub.req("GET", `/api/public/consent/${l.json.token}`)).json;
      const r = await pub.req("POST", `/api/public/consent/${l.json.token}`, {
        recording: false,
        analysis: false,
        candidateName: "Meet の人",
        consentVersion: info.details.consent.version,
      });
      expect(r.status).toBe(200);
      return (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    };
    // 面接の最中に断られた: 予定日時の前でも、録画なしで行った面接として評価に進む
    const during = await answer("meeting");
    expect(during.interview.consent!.atInterview).toBe(true);
    expect(during.status).toBe("evaluating");
    // 事前のリンクで断られた: 予定日時までは「録画前」
    const before = await answer("advance");
    expect(before.interview.consent!.atInterview).toBe(false);
    expect(before.status).toBe("scheduled");
    const fresh = ((await create({ format: "online" })).json as InterviewDetail).interview.id;
    expect((await alice.req("POST", `/api/interviews/${fresh}/consent-links`, { purpose: "later" })).status).toBe(400);
  });

  it("Google Meet のタブで録った録画・オンライン面接に取り込んだ Meet の録画は capture = screen として残る。指定がなければカメラ", async () => {
    const iid = await newInterview(alice, { candidate: { displayName: "Meet で録画" }, format: "online", interviewerIds: [ids.alice] });
    const rid = await readyRecording(server, alice, iid, "dev-meet-tab-1", "screen");
    let d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings.find((r) => r.id === rid)!.capture).toBe("screen");

    // 指定しなければカメラ
    const cam = await readyRecording(server, alice, iid, "dev-meet-cam-1");
    // 取り込み(file)も指定どおり(オンライン面接では、画面が screen を指定して Meet の録画として取り込む)
    const f = await alice.req("POST", `/api/interviews/${iid}/recordings`, {
      clientId: "dev-meet-file-1",
      source: "file",
      capture: "screen",
      mimeType: "video/webm",
      fileName: "meet.webm",
    });
    expect(f.status).toBe(200);
    const f2 = await alice.req("POST", `/api/interviews/${iid}/recordings`, {
      clientId: "dev-meet-file-2",
      source: "file",
      mimeType: "video/webm",
      fileName: "camcorder.webm",
    });
    expect((await alice.req("POST", `/api/interviews/${iid}/recordings`, { clientId: "dev-meet-bad-1", source: "live", capture: "tv", mimeType: "video/webm" })).status).toBe(400);
    d = (await alice.req("GET", `/api/interviews/${iid}`)).json as InterviewDetail;
    expect(d.interview.recordings.find((r) => r.id === cam)!.capture).toBe("camera");
    expect(d.interview.recordings.find((r) => r.id === f.json.recording.id)!.capture).toBe("screen");
    expect(d.interview.recordings.find((r) => r.id === f2.json.recording.id)!.capture).toBe("camera");
    // 送信の合言葉なしでは送れない(画面の共有の録画も同じ)
    expect(
      (await alice.req("PUT", `/api/interviews/${iid}/recordings/${f.json.recording.id}/chunks/0`, undefined, { raw: WEBM(), headers: fromDevice("other-device") })).status,
    ).toBe(403);
  });

  it("v0.3 までの面接・録画は、対面・カメラとして読み込む", async () => {
    const iid = await newInterview(alice, { candidate: { displayName: "古い面接" } });
    await readyRecording(server, alice, iid, "dev-old-1");
    const iv = server.app.ctx.store.interviews.get(iid)!;
    // 古いデータの形にする(形式・リンク・録画の映像の元がない)
    const raw = JSON.parse(JSON.stringify(iv)) as Record<string, unknown> & { recordings: Record<string, unknown>[] };
    delete raw.format;
    delete raw.meetUrl;
    for (const r of raw.recordings) delete r.capture;
    await server.app.ctx.store.saveInterview(raw as never);
    const restarted = await startServer({ dataDir: server.dataDir });
    try {
      const loaded = restarted.app.ctx.store.interviews.get(iid)!;
      expect(loaded.format).toBe("inPerson");
      expect(loaded.meetUrl).toBeNull();
      expect(loaded.recordings[0].capture).toBe("camera");
    } finally {
      await restarted.close();
    }
  });
});
