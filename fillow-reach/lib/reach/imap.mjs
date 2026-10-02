import { connect } from "node:tls";
import { parseSearchIds } from "../../../lib/imap.mjs";
import { decodeMime } from "../../../lib/gmail.mjs";

export { parseSearchIds };

// Parent lib/imap.mjs exports only parseSearchIds; this local port exists
// because the parent repo is read-only to Reach (user directive). Keep
// behavior aligned with ../../../lib/imap.mjs's internal versions.
export function decodeBase64(value) {
  try {
    return Buffer.from(String(value || "").replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function header(raw, name) {
  const re = new RegExp(`^${name}:\\s*(.*)$`, "im");
  const m = String(raw || "").match(re);
  return m ? m[1].trim() : "";
}

export function parseMessage(raw, id) {
  return {
    id,
    from: header(raw, "From"),
    subject: header(raw, "Subject"),
    date: header(raw, "Date"),
    body: decodeMime(raw),
    raw,
  };
}

export function imapConnectionOptions({ host = "imap.gmail.com", port = 993, servername } = {}) {
  return { host, port, tls: { servername: servername ?? host } };
}

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function withImap(user, password, fn, opts = {}) {
  if (!user || !password) throw new Error("IMAP user/password missing");

  const conn = imapConnectionOptions(opts);
  const socket = connect({ host: conn.host, port: conn.port, servername: conn.tls.servername });
  socket.setEncoding("utf8");
  let buf = "";
  let n = 0;
  let dead = null;

  const onSocketError = (err) => {
    dead = dead || err;
  };
  socket.on("error", onSocketError);

  const waitBytes = () =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      const t = setTimeout(() => reject(new Error("IMAP timeout")), 30000);
      const onData = (chunk) => {
        buf += chunk;
        cleanup();
        resolve();
      };
      const onErr = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(t);
        socket.off("data", onData);
        socket.off("error", onErr);
      };
      socket.once("data", onData);
      socket.once("error", onErr);
    });

  async function readUntil(pred) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (pred(buf)) {
        const value = buf;
        buf = "";
        return value;
      }
      await waitBytes();
    }
    throw new Error("IMAP read timeout");
  }

  async function command(cmd) {
    n += 1;
    const id = `A${String(n).padStart(4, "0")}`;
    socket.write(`${id} ${cmd}\r\n`);
    // Read until the tagged response line arrives; untagged data and
    // "+ id continuation" chunks accumulate in buf alongside it.
    const raw = await readUntil((s) => new RegExp(`(?:^|\\r\\n)${id} `).test(s));
    const lines = raw.split(/\r\n/).filter(Boolean);
    const bad = lines.find((l) => l === "* BAD" || l.startsWith("* BAD "));
    if (bad) throw new Error(bad);
    const status = lines.find((l) => l.startsWith(`${id} `)) || "";
    if (!status.startsWith(`${id} OK`)) throw new Error(status || `IMAP failed: ${cmd}`);
    return lines;
  }

  async function login() {
    await command(`LOGIN ${quote(user)} ${quote(password)}`);
  }

  async function logout() {
    try {
      socket.write("A9999 LOGOUT\r\n");
    } catch {
      // ignore
    }
    socket.end();
  }

  let runningFn = false;
  try {
    await readUntil((s) => s.includes("\r\n") && (s.includes("* OK") || s.includes("* PREAUTH")));
    buf = "";
    await login();
    runningFn = true;
    return await fn({ command });
  } catch (err) {
    // Errors from the callback destroy the socket before rethrow so a
    // poisoned session is never reused.
    if (runningFn) socket.destroy();
    throw err;
  } finally {
    await logout();
  }
}
