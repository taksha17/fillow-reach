import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

export const DEFAULT_GGUF_NAME = "qwen2.5-1.5b-instruct-q4_k_m.gguf";
export const DEFAULT_QWEN_URL = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";

const N_PREDICT = 256;
const CTX = 2048;

export function localGgufPath(reachCfg) {
  return reachCfg.localLlm?.ggufPath
    ?? join(reachCfg.paths.reachDir, "models", DEFAULT_GGUF_NAME);
}

export function localLlmUrl(reachCfg) {
  return reachCfg.localLlm?.url ?? DEFAULT_QWEN_URL;
}

export function hasLocalGguf(reachCfg) {
  return existsSync(localGgufPath(reachCfg));
}

function writeBinaryAtomic(dest, buf) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.${process.pid}.${Date.now()}.gguf.tmp`);
  writeFileSync(tmp, buf);
  renameSync(tmp, dest);
}

export async function pullLocalLlm(reachCfg, { fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("pullLocalLlm: no fetch available");
  }
  const url = localLlmUrl(reachCfg);
  const dest = localGgufPath(reachCfg);
  const res = await fetchImpl(url);
  if (!res?.ok) {
    const status = res?.status ?? "network";
    throw new Error(`pull-llm failed: ${status} fetching ${url}`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  writeBinaryAtomic(dest, bytes);
  return dest;
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
          "llama-cli not found — install llama.cpp (CPU) to run the bundled Qwen GGUF, or inject inferImpl",
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
      resolve(stdout.trim());
    });
  });
  return text;
}

export function makeLocalChat(reachCfg, { inferImpl, llamaBin } = {}) {
  return async (system, user) => {
    if (!hasLocalGguf(reachCfg)) {
      throw new Error("local Qwen GGUF missing — run reach setup --pull-llm");
    }
    const infer = inferImpl ?? ((opts) => inferViaLlamaCli({ ...opts, llamaBin }));
    return infer({
      ggufPath: localGgufPath(reachCfg),
      system,
      user,
      nPredict: N_PREDICT,
      ctx: CTX,
    });
  };
}
