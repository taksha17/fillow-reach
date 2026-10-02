import assert from "node:assert/strict";
import test from "node:test";
import { parseSearchIds as parentParseSearchIds } from "../../lib/imap.mjs";
import {
  decodeBase64,
  imapConnectionOptions,
  parseMessage,
  parseSearchIds,
  withImap,
} from "../lib/reach/imap.mjs";

test("imapConnectionOptions defaults to gmail host/993 with servername", () => {
  assert.deepEqual(imapConnectionOptions(), {
    host: "imap.gmail.com",
    port: 993,
    tls: { servername: "imap.gmail.com" },
  });
});

test("imapConnectionOptions flows a custom host/port through; servername defaults to host", () => {
  assert.deepEqual(imapConnectionOptions({ host: "imap.fastmail.com", port: 993 }), {
    host: "imap.fastmail.com",
    port: 993,
    tls: { servername: "imap.fastmail.com" },
  });
});

test("imapConnectionOptions honors an explicit servername", () => {
  assert.deepEqual(imapConnectionOptions({ host: "localhost", servername: "alt.test" }), {
    host: "localhost",
    port: 993,
    tls: { servername: "alt.test" },
  });
});

test("re-exported parseSearchIds is the identical function reference as the parent's", () => {
  assert.equal(parseSearchIds, parentParseSearchIds);
});

test("parseSearchIds parses a canned SEARCH line", () => {
  assert.deepEqual(parseSearchIds(["* SEARCH 1 2 42", "A0001 OK SEARCH completed"]), ["1", "2", "42"]);
});

test("decodeBase64 decodes and tolerates garbage", () => {
  assert.equal(decodeBase64("aGVsbG8="), "hello");
  assert.equal(decodeBase64(""), "");
});

test("parseMessage extracts headers and a plain body", () => {
  const raw = [
    "From: Recruiter <recruiter@example.com>",
    "Subject: Interview",
    "Date: Tue, 30 Sep 2026 10:00:00 +0000",
    "Content-Type: text/plain",
    "",
    "Can you do Thursday?",
  ].join("\r\n");
  const msg = parseMessage(raw, "7");
  assert.equal(msg.id, "7");
  assert.equal(msg.from, "Recruiter <recruiter@example.com>");
  assert.equal(msg.subject, "Interview");
  assert.equal(msg.date, "Tue, 30 Sep 2026 10:00:00 +0000");
  assert.match(msg.body, /Can you do Thursday\?/);
  assert.equal(msg.raw, raw);
});

test("withImap throws on missing credentials before connecting", async () => {
  await assert.rejects(() => withImap("", "x", async () => {}), /user\/password missing/);
  await assert.rejects(() => withImap("u", "", async () => {}), /user\/password missing/);
});
