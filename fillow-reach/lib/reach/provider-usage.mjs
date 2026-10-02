export function currentMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function readProviderUsage(db, provider, month = currentMonth()) {
  const row = db.prepare("SELECT calls FROM provider_usage WHERE provider = ? AND month = ?").get(provider, month);
  return row?.calls ?? 0;
}

export function incrementProviderUsage(db, provider, n = 1, month = currentMonth()) {
  db.prepare(
    `INSERT INTO provider_usage (provider, month, calls) VALUES (?, ?, ?)
     ON CONFLICT(provider, month) DO UPDATE SET calls = calls + excluded.calls`,
  ).run(provider, month, n);
  return readProviderUsage(db, provider, month);
}
