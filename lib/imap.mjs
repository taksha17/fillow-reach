import { connect } from "node:tls";

function quote(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function withImap(user, password, fn) {
  if (!user || !password) throw new Error("Gmail IMAP user/password missing");

  const socket = connect({ host: "imap.gmail.com", port: 993, servername: "imap.gmail.com" });
  socket.setEncoding("utf8");
  let buf = "";
  let n = 0;

  const waitBytes = () =>
    new Promise((resolve, reject) => {
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
    const raw = await readUntil((s) => new RegExp(`(?:^|\\r\\n)${id} `).test(s));
    const lines = raw.split(/\r\n/).filter(Boolean);
    const status = lines.find((l) => l.startsWith(`${id} `)) || "";
    if (!status.startsWith(`${id} OK`)) throw new Error(status || `IMAP failed: ${cmd}`);
    return lines;
  }

  try {
    await readUntil((s) => s.includes("\r\n") && (s.includes("* OK") || s.includes("* PREAUTH")));
    buf = "";
    await command(`LOGIN ${quote(user)} ${quote(password)}`);
    return await fn({ command });
  } finally {
    try {
      socket.write("A9999 LOGOUT\r\n");
    } catch {
      // ignore
    }
    socket.end();
  }
}

export function parseSearchIds(lines) {
  const line = lines.find((l) => l.startsWith("* SEARCH")) || "";
  return line
    .replace("* SEARCH", "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}
