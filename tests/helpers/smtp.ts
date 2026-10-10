// テスト用の SMTP サーバー(受け取ったメールを記録するだけ。TLS・認証なし)。

import net from "node:net";

export type ReceivedMail = { from: string; to: string[]; subject: string; text: string; raw: string };

function decodeWords(s: string): string {
  // =?UTF-8?B?...?= / =?UTF-8?Q?...?= (隣り合う符号化語の間の空白は詰める)
  return s
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, _cs: string, enc: string, data: string) =>
      enc.toUpperCase() === "B"
        ? Buffer.from(data, "base64").toString("utf8")
        : Buffer.from(
            data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
            "latin1",
          ).toString("utf8"),
    );
}

function decodeBody(body: string, encoding: string): string {
  const enc = encoding.toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    const bytes = body.replace(/=\r\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}

function parse(from: string, to: string[], raw: string): ReceivedMail {
  const sep = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, sep).replace(/\r\n[ \t]+/g, " ");
  const body = raw.slice(sep + 4);
  const header = (name: string) => head.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))?.slice(name.length + 1).trim() ?? "";
  return { from, to, subject: decodeWords(header("Subject")), text: decodeBody(body, header("Content-Transfer-Encoding") || "7bit"), raw };
}

export async function startSmtp(): Promise<{
  port: number;
  mails: ReceivedMail[];
  waitFor: (n: number, ms?: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  const mails: ReceivedMail[] = [];
  const server = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    let cur = { from: "", to: [] as string[], lines: [] as string[] };
    const reply = (s: string) => sock.write(`${s}\r\n`);
    reply("220 localhost ESMTP test");
    sock.setEncoding("latin1");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf("\r\n"); i >= 0; i = buf.indexOf("\r\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            mails.push(parse(cur.from, cur.to, Buffer.from(cur.lines.join("\r\n"), "latin1").toString("utf8")));
            cur = { from: "", to: [], lines: [] };
            reply("250 OK queued");
          } else {
            cur.lines.push(line.startsWith("..") ? line.slice(1) : line);
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        const arg = (line.match(/<([^>]*)>/) ?? [])[1] ?? "";
        if (cmd === "EHLO") {
          reply("250-localhost");
          reply("250 8BITMIME");
        } else if (cmd === "HELO") reply("250 localhost");
        else if (cmd === "MAIL") {
          cur.from = arg;
          reply("250 OK");
        } else if (cmd === "RCPT") {
          cur.to.push(arg);
          reply("250 OK");
        } else if (cmd === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (cmd === "RSET") {
          cur = { from: "", to: [], lines: [] };
          reply("250 OK");
        } else if (cmd === "NOOP") reply("250 OK");
        else if (cmd === "QUIT") {
          reply("221 Bye");
          sock.end();
        } else reply("502 Not implemented");
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    mails,
    async waitFor(n, ms = 5000) {
      const until = Date.now() + ms;
      while (mails.length < n) {
        if (Date.now() > until) throw new Error(`メールが ${n} 通届きません(${mails.length} 通)`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
