import {
  chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync,
  readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_GGUF_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
export const DEFAULT_QWEN_URL = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
export const LLAMA_RELEASES_URL = "https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=30";
export const LOCAL_MODEL_ID = "qwen2.5-1.5b-instruct";

const N_PREDICT = 256;
const CTX = 2048;

export function llamaCliName(platform = process.platform) {
  return platform === "win32" ? "llama-cli.exe" : "llama-cli";
}

export function localGgufPath(reachCfg) {
  return reachCfg.localLlm?.ggufPath
    ?? join(reachCfg.paths.reachDir, "models", DEFAULT_GGUF_NAME);
}

export function localLlmUrl(reachCfg) {
  return reachCfg.localLlm?.url ?? DEFAULT_QWEN_URL;
}

export function bundledLlamaPath(reachCfg, platform = process.platform) {
  return reachCfg.localLlm?.llamaBin
    ?? join(reachCfg.paths.reachDir, "bin", llamaCliName(platform));
}

export function hasLocalGguf(reachCfg) {
  return existsSync(localGgufPath(reachCfg));
}

export function llamaAssetPattern(platform = process.platform, arch = process.arch) {
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) return /ubuntu-x64\.tar\.gz$/i;
  if (platform === "linux" && arch === "arm64") return /ubuntu-arm64\.tar\.gz$/i;
  if (platform === "darwin" && arch === "arm64") return /macos-arm64\.tar\.gz$/i;
  if (platform === "darwin") return /macos-x64\.tar\.gz$/i;
  if (platform === "win32") return /win-cpu-x64\.zip$/i;
  throw new Error(`unsupported platform ${platform}/${arch} for bundled llama.cpp`);
}

export function pickLlamaAsset(releases, { platform = process.platform, arch = process.arch } = {}) {
  const list = Array.isArray(releases) ? releases : [releases];
  const re = llamaAssetPattern(platform, arch);
  for (const rel of list) {
    for (const a of rel.assets ?? []) {
      if (re.test(a.name)) {
        return { name: a.name, url: a.browser_download_url, tag: rel.tag_name };
      }
    }
  }
  throw new Error(`no llama.cpp CPU build for ${platform}/${arch} — set REACH_LLAMA_BIN`);
}

export function hasLocalRuntime(reachCfg, { whichImpl } = {}) {
  if (existsSync(bundledLlamaPath(reachCfg))) return true;
  if (typeof whichImpl === "function") return Boolean(whichImpl());
  try {
    const r = spawnSync("llama-cli", ["-h"], { timeout: 3000, stdio: "ignore" });
    return r.error?.code !== "ENOENT" && r.status !== null;
  } catch {
    return false;
  }
}

export function resolveLlamaBin(reachCfg) {
  const bundled = bundledLlamaPath(reachCfg);
  if (existsSync(bundled)) return bundled;
  return "llama-cli";
}

export function localLlmStatus(reachCfg) {
  const gguf = localGgufPath(reachCfg);
  const present = hasLocalGguf(reachCfg);
  const bundled = existsSync(bundledLlamaPath(reachCfg));
  return {
    model: LOCAL_MODEL_ID,
    gguf: { path: gguf, present, bytes: present ? statSync(gguf).size : 0 },
    runtime: {
      path: bundledLlamaPath(reachCfg),
      bundled,
      present: hasLocalRuntime(reachCfg),
    },
  };
}

export function extractChatText(raw) {
  const text = String(raw ?? "");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const json = candidate.match(/\{[\s\S]*\}/);
  return (json ? json[0] : candidate).trim();
}

function writeBinaryAtomic(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${process.pid}.${Date.now()}.gguf.tmp`);
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

async function writeResponseToFile(res, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  if (res.body && typeof Readable.fromWeb === "function") {
    try {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      renameSync(tmp, dest);
      return;
    } catch {
      // tests pass arrayBuffer-only stubs
    }
  }
  if (typeof res.arrayBuffer !== "function") {
    throw new Error("pull-llm: response has neither a stream body nor arrayBuffer()");
  }
  writeBinaryAtomic(dest, Buffer.from(await res.arrayBuffer()));
}

export async function pullLocalLlm(reachCfg, { fetchImpl = globalThis.fetch, force = false } = {}) {
  const dest = localGgufPath(reachCfg);
  if (!force && existsSync(dest)) return dest;
  if (typeof fetchImpl !== "function") {
    throw new Error("pullLocalLlm: no fetch available");
  }
  const url = localLlmUrl(reachCfg);
  const res = await fetchImpl(url);
  if (!res?.ok) {
    const status = res?.status ?? "network";
    throw new Error(`pull-llm failed: ${status} fetching ${url}`);
  }
  await writeResponseToFile(res, dest);
  return dest;
}

function findNamed(dir, name, depth = 0) {
  if (depth > 6) return null;
  const direct = join(dir, name);
  if (existsSync(direct)) return direct;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findNamed(join(dir, e.name), name, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function extractArchive(archivePath, destDir) {
  mkdirSync(destDir, { recursive: true });
  const unzip = archivePath.endsWith(".zip");
  const r = unzip
    ? spawnSync("unzip", ["-o", "-q", archivePath, "-d", destDir], { encoding: "utf8" })
    : spawnSync("tar", ["-xzf", archivePath, "-C", destDir], { encoding: "utf8" });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(r.stderr || r.stdout || "extract failed");
}

export async function pullLocalRuntime(reachCfg, {
  fetchImpl = globalThis.fetch,
  extractImpl,
  force = false,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const dest = bundledLlamaPath(reachCfg, platform);
  if (!force && existsSync(dest)) return dest;
  if (typeof fetchImpl !== "function") throw new Error("pullLocalRuntime: no fetch available");

  let archiveUrl = reachCfg.localLlm?.runtimeUrl;
  if (!archiveUrl) {
    const api = await fetchImpl(LLAMA_RELEASES_URL);
    if (!api?.ok) throw new Error(`llama.cpp releases ${api?.status ?? "failed"}`);
    if (typeof api.json !== "function") throw new Error("llama.cpp releases: no json()");
    archiveUrl = pickLlamaAsset(await api.json(), { platform, arch }).url;
  }
  const res = await fetchImpl(archiveUrl);
  if (!res?.ok) throw new Error(`pull runtime failed: ${res?.status ?? "network"} fetching ${archiveUrl}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const tmpDir = join(dirname(dest), `.extract-${process.pid}-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  try {
    const archivePath = join(tmpDir, "llama.archive");
    writeFileSync(archivePath, bytes);
    if (extractImpl) await extractImpl(archivePath, tmpDir);
    else extractArchive(archivePath, tmpDir);
    const found = findNamed(tmpDir, llamaCliName(platform));
    if (!found) throw new Error("llama.cpp archive did not contain llama-cli");
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(found, dest);
    try { chmodSync(dest, 0o755); } catch { /* windows */ }
    return dest;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function chatMl(system, user) {
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

async function inferViaLlamaCli({ ggufPath, system, user, llamaBin = "llama-cli" }) {
  const prompt = chatMl(system, user);
  const args = [
    "-m", ggufPath,
    "-n", String(N_PREDICT),
    "-c", String(CTX),
    "--no-display-prompt",
    "-p", prompt,
  ];
  const text = await new Promise((resolve, reject) => {
    const child = spawn(llamaBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error(
          "llama-cli not found — run reach llm --pull to fetch a CPU llama.cpp binary",
        ));
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`llama-cli exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(extractChatText(stdout));
    });
  });
  return text;
}

export function makeLocalChat(reachCfg, { inferImpl, llamaBin } = {}) {
  return async (system, user) => {
    if (!hasLocalGguf(reachCfg)) {
      throw new Error("local Qwen GGUF missing — run reach setup --pull-llm");
    }
    const bin = llamaBin ?? resolveLlamaBin(reachCfg);
    const infer = inferImpl ?? ((opts) => inferViaLlamaCli({ ...opts, llamaBin: bin }));
    return infer({
      ggufPath: localGgufPath(reachCfg),
      system,
      user,
      nPredict: N_PREDICT,
      ctx: CTX,
    });
  };
}
