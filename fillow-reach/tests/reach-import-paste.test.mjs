import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadReachConfig } from "../lib/reach/config.mjs";
import { openReachMigratedDb } from "../lib/reach/db.mjs";
import { parsePaste, importPaste } from "../lib/reach/import-paste.mjs";
import { addSuppression } from "../lib/reach/people.mjs";
import { runReachCli } from "../lib/reach/cli.mjs";

function fixture(profileYaml = "reach:\n  enabled: true\n") {
  const dir = mkdtempSync(join(tmpdir(), "reach-paste-"));
  const profileFile = join(dir, "profile.yaml");
  const envFile = join(dir, ".env");
  const dataDir = join(dir, "data");
  writeFileSync(profileFile, profileYaml, "utf8");
  writeFileSync(envFile, "", "utf8");
  const cfg = loadReachConfig({ profileFile, envFile, dataDir });
  const db = openReachMigratedDb(cfg);
  return { db, cfg, dir, profileFile, envFile, dataDir };
}

async function cli(argv, fx) {
  let out = "";
  const code = await runReachCli(argv, { stdout: { write: (s) => { out += String(s); } }, ...fx });
  return { code, out };
}

test("1. parsePaste: single-line `Name — Title at Company` + inline URL", () => {
  const rows = parsePaste("Jane Doe — Senior Recruiter at Acme https://www.linkedin.com/in/janedoe");
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { ...rows[0] },
    { full_name: "Jane Doe", title: "Senior Recruiter", company: "Acme", linkedin_url: "https://www.linkedin.com/in/janedoe" }
  );
});

test("2. parsePaste: three-line block Name / Title at Company / linkedin.com/in/...", () => {
  const rows = parsePaste("John Roe\nHiring Manager at Beta Corp\nlinkedin.com/in/john-roe");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, "John Roe");
  assert.equal(rows[0].title, "Hiring Manager");
  assert.equal(rows[0].company, "Beta Corp");
  assert.equal(rows[0].linkedin_url, "linkedin.com/in/john-roe");
});

test("3. parsePaste skips lines with no name and keeps the URL regex tight", () => {
  const rows = parsePaste("\nAbout\nlinkedin.com/in/ghost\n\nJane Doe — Recruiter at Acme\nlinkedin.com/pages/company");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].full_name, "Jane Doe");
  assert.equal(rows[0].linkedin_url, undefined);
  const strict = parsePaste("no url here — Recruiter at Acme");
  assert.equal(strict[0].linkedin_url, undefined);
});

test("4. importPaste apply=false writes nothing, returns preview", () => {
  const { db } = fixture();
  const text = "Jane Doe — Senior Recruiter at Acme\nhttps://www.linkedin.com/in/janedoe";
  const res = importPaste(db, text, { apply: false });
  assert.equal(res.parsed, 1);
  assert.equal(res.imported, 0);
  assert.equal(res.preview.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM company").get().n, 0);
  db.close();
});

test("5. importPaste apply=true imports with source paste_import + persona from title", () => {
  const { db } = fixture();
  const text = [
    "Jane Doe — Senior Recruiter at Acme https://www.linkedin.com/in/janedoe",
    "",
    "John Roe\nEngineering Manager at Beta\nlinkedin.com/in/john-roe",
    "",
    "Ann Lee — Staff Engineer at Gamma",
  ].join("\n");
  const res = importPaste(db, text, { apply: true });
  assert.equal(res.parsed, 3);
  assert.equal(res.imported, 3);
  const jane = db.prepare("SELECT p.persona, p.source, c.name AS company FROM person p JOIN company c ON c.id=p.company_id WHERE p.full_name='Jane Doe'").get();
  assert.equal(jane.persona, "recruiter");
  assert.equal(jane.source, "paste_import");
  assert.equal(jane.company, "Acme");
  const ann = db.prepare("SELECT persona FROM person WHERE full_name='Ann Lee'").get();
  assert.equal(ann.persona, "senior_ic");
  const ev = db.prepare("SELECT detail FROM event_log WHERE action='paste_imported'").get();
  assert.ok(ev, "paste_imported event missing");
  db.close();
});

test("6. importPaste: suppressed linkedin_url counts skipped, no person row", () => {
  const { db } = fixture();
  addSuppression(db, { kind: "linkedin_url", value: "linkedin.com/in/janedoe", reason: "manual" });
  const res = importPaste(db, "Jane Doe — Recruiter at Acme\nlinkedin.com/in/janedoe", { apply: true });
  assert.equal(res.imported, 0);
  assert.equal(res.skipped, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("7. CLI import --paste without --yes: preview only, writes 0 rows", async () => {
  const fx = fixture();
  const p = join(fx.dir, "paste.txt");
  writeFileSync(p, "Jane Doe — Senior Recruiter at Acme\nhttps://www.linkedin.com/in/janedoe", "utf8");
  const { code, out } = await cli(["import", "--paste", "--file", p], fx);
  assert.equal(code, 0);
  assert.ok(/not written/i.test(out), out);
  assert.ok(/pass --yes/i.test(out), out);
  const db = openReachMigratedDb(fx.cfg);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 0);
  db.close();
});

test("8. CLI import --paste --yes writes the person", async () => {
  const fx = fixture();
  const p = join(fx.dir, "paste.txt");
  writeFileSync(p, "Jane Doe — Senior Recruiter at Acme\nhttps://www.linkedin.com/in/janedoe", "utf8");
  const { code, out } = await cli(["import", "--paste", "--yes", "--file", p], fx);
  assert.equal(code, 0, out);
  const db = openReachMigratedDb(fx.cfg);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person").get().n, 1);
  db.close();
});

test("9. CLI import <csv-path> without --paste runs the M1 CSV flow (preview only)", async () => {
  const fx = fixture();
  const p = join(fx.dir, "connections.csv");
  writeFileSync(p, "First Name,Last Name,Company,Position,URL,Email Address\nJane,Doe,Acme,Engineer,https://www.linkedin.com/in/janedoe,jane@acme.test\n", "utf8");
  const { code, out } = await cli(["import", p], fx);
  assert.equal(code, 0, out);
  assert.ok(/not written/i.test(out), out);
  assert.ok(/pass --yes/i.test(out), out);
});
