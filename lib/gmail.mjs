// Slim decodeMime only — Reach IMAP parses bodies. Full gmail.mjs in fillow
// pulls LLM/OTP and is not copied here.

function decodeQuotedPrintable(value) {
  return String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(value) {
  try {
    return Buffer.from(String(value || "").replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function stripImapFetchWrapper(raw) {
  return String(raw || "").replace(/^\* \d+ FETCH[^\n]*\n/i, "").replace(/\)\s*$/, "");
}

export function decodeMime(raw) {
  const text = stripImapFetchWrapper(raw);
  const chunks = [];

  const boundaryMatch = text.match(/boundary="?([^";\s]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    const parts = text.split(new RegExp(`\\r?\\n--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));
    for (const part of parts) {
      if (!/content-type:\s*text\/(plain|html)/i.test(part)) continue;
      const splitAt = part.search(/\r?\n\r?\n/);
      const headers = splitAt >= 0 ? part.slice(0, splitAt) : part;
      let body = splitAt >= 0 ? part.slice(splitAt).replace(/^\r?\n\r?\n/, "") : "";
      if (!body.trim()) {
        const htmlStart = part.search(/<!DOCTYPE|<html/i);
        if (htmlStart >= 0) body = part.slice(htmlStart);
      }
      if (/quoted-printable/i.test(headers) || /quoted-printable/i.test(part.slice(0, 400))) {
        body = decodeQuotedPrintable(body);
      } else if (/base64/i.test(headers) && !/<html/i.test(body.slice(0, 200))) {
        body = decodeBase64(body);
      }
      chunks.push(body);
    }
  }

  if (!chunks.length) {
    const re =
      /Content-Type:\s*(text\/(?:plain|html))[^\n]*\n([\s\S]*?)(?:\r?\n\r?\n|<\s*(?:!DOCTYPE|html))([\s\S]*?)(?=\r?\n--|\r?\nContent-Type:|$)/gi;
    let m;
    while ((m = re.exec(text))) {
      const headers = m[2] || "";
      let part = m[3] || "";
      if (/^html/i.test(part) || /^!DOCTYPE/i.test(part)) part = `<${part}`;
      if (/quoted-printable/i.test(headers) || /quoted-printable/i.test(text.slice(Math.max(0, m.index - 80), m.index))) {
        part = decodeQuotedPrintable(part);
      } else if (/base64/i.test(headers)) part = decodeBase64(part);
      chunks.push(part);
    }
  }

  if (!chunks.length) {
    chunks.push(decodeQuotedPrintable(text));
  }
  return chunks.join("\n").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
