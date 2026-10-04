import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { robotsAllows, extractPeople, importPublicPage } from "../lib/reach/public-pages.mjs";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "reach-pages-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, "reach:\n  enabled: true\n", "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg };
}

function res(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => body, headers };
}

test("1. robotsAllows: star-group Disallow prefixes deny; everything else allows", () => {
  const robots = "User-agent: *\nDisallow: /private\nAllow: /\n\nUser-agent: googlebot\nDisallow: /\n";
  assert.equal(robotsAllows(robots, "/private/x"), false);
  assert.equal(robotsAllows(robots, "/team"), true);
  assert.equal(robotsAllows("User-agent: *\nDisallow: /\n", "/anything"), false);
  assert.equal(robotsAllows("", "/team"), true);
  assert.equal(robotsAllows("User-agent: bing\nDisallow: /\n", "/team"), true);
});

test("2. importPublicPage: robots Disallow -> skipped, no upsert, event logged, page never fetched", async () => {
  const { db } = fixture();
  let pageFetches = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) return res(200, "User-agent: *\nDisallow: /\n");
    pageFetches += 1;
    return res(200, "<html></html>");
  };
  const out = await importPublicPage(db, "https://acme.test/team", { fetchImpl });
  assert.deepEqual({ imported: out.imported, skipped: out.skipped, reason: out.reason }, { imported: 0, skipped: 1, reason: "blocked" });
  assert.equal(pageFetches, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  const ev = db.prepare("SELECT detail FROM event_log WHERE action='public_page_skipped'").get();
  assert.ok(ev, "public_page_skipped event missing");
  db.close();
});

test("3. importPublicPage: 200 team page with itemprop name/jobTitle + /in/ link imports a person", async () => {
  const { db } = fixture();
  const html = [
    "<html><body>",
    '<h2 itemprop="name">Jane Doe</h2>',
    '<p itemprop="jobTitle">Senior Recruiter</p>',
    '<a href="https://www.linkedin.com/in/janedoe">profile</a>',
    "</body></html>",
  ].join("\n");
  const fetchImpl = async (url) => (url.endsWith("/robots.txt") ? res(200, "User-agent: *\nAllow: /\n") : res(200, html));
  const out = await importPublicPage(db, "https://acme.test/team", { fetchImpl });
  assert.equal(out.imported, 1, JSON.stringify(out));
  const row = db.prepare(
    "SELECT p.full_name, p.title, p.source, p.persona, p.linkedin_url, c.name AS company FROM person p JOIN company c ON c.id=p.company_id WHERE p.full_name='Jane Doe'"
  ).get();
  assert.equal(row.title, "Senior Recruiter");
  assert.equal(row.source, "public_page");
  assert.equal(row.persona, "recruiter");
  assert.equal(row.linkedin_url, "linkedin.com/in/janedoe"); // normalized per M1 contract
  assert.equal(row.company, "acme.test");
  db.close();
});

test("4. importPublicPage: anchor text `Name — Title` yields a row too", () => {
  const rows = extractPeople('<a href="linkedin.com/in/janedoe">Jane Doe — Senior Recruiter at Acme</a>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, "Jane Doe");
  assert.equal(rows[0].title, "Senior Recruiter at Acme");
  const noise = extractPeople('<a href="linkedin.com/in/janedoe">profile</a>');
  assert.equal(noise.length, 0);
});

test("5. importPublicPage: 403 -> skipped/blocked, no throw", async () => {
  const { db } = fixture();
  const fetchImpl = async (url) => (url.endsWith("/robots.txt") ? res(200, "User-agent: *\nAllow: /\n") : res(403, "nope"));
  const out = await importPublicPage(db, "https://acme.test/team", { fetchImpl });
  assert.deepEqual({ skipped: out.skipped, reason: out.reason }, { skipped: 1, reason: "blocked" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("6. importPublicPage: 404 -> not_found", async () => {
  const { db } = fixture();
  const fetchImpl = async (url) => (url.endsWith("/robots.txt") ? res(200, "User-agent: *\nAllow: /\n") : res(404, ""));
  const out = await importPublicPage(db, "https://acme.test/team", { fetchImpl });
  assert.equal(out.reason, "not_found");
  db.close();
});

test("7. importPublicPage: robots.txt unreachable (fetch throws) is an allow", async () => {
  const { db } = fixture();
  const fetchImpl = async (url) => {
    if (url.endsWith("/robots.txt")) throw new Error("ECONNREFUSED");
    return res(200, '<a href="https://www.linkedin.com/in/janedoe">Jane Doe</a>');
  };
  const out = await importPublicPage(db, "https://acme.test/team", { fetchImpl });
  assert.equal(out.imported, 1);
  db.close();
});

test("8. extractPeople splits a name from a trailing role in the same label", () => {
  const rows = extractPeople(
    '<a href="https://www.linkedin.com/in/karrisaarinen">Karri Saarinen Co-founder, CEO</a>',
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, "Karri Saarinen");
  assert.match(rows[0].title, /Co-founder/i);
});
