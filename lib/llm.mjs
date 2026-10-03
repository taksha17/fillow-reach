// Deliberate local port of the parent fillow repo's lib/llm.mjs (Groq → NIM →
// OpenAI chain). fillow-reach/draft.mjs lazily imports ../../../lib/llm.mjs;
// the standalone repo needs it at this exact path. Keep in sync with the parent.
const NIM_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const DEFAULT_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const DEFAULT_TIMEOUT_MS = 180000;
export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_REASONING_BUDGET = 1024;

export function llmAvailable(cfg) {
  return Boolean(cfg?.secrets?.nvidia_api_key || cfg?.secrets?.groq_api_key || cfg?.secrets?.openai_api_key);
}

/** Ordered LLM backends: Groq → NVIDIA NIM → OpenAI (first with a key). */
export function llmProviders(cfg) {
  const out = [];
  if (cfg?.secrets?.groq_api_key) {
    out.push({
      id: "groq",
      name: "Groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      key: cfg.secrets.groq_api_key,
    });
  }
  if (cfg?.secrets?.nvidia_api_key) {
    out.push({
      id: "nvidia",
      name: "NVIDIA NIM",
      url: NIM_URL,
      key: cfg.secrets.nvidia_api_key,
    });
  }
  if (cfg?.secrets?.openai_api_key) {
    out.push({
      id: "openai",
      name: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      key: cfg.secrets.openai_api_key,
    });
  }
  return out;
}

function cfgScopedToProvider(cfg, providerId) {
  return {
    ...cfg,
    secrets: {
      ...cfg.secrets,
      nvidia_api_key: providerId === "nvidia" ? cfg.secrets.nvidia_api_key : "",
      groq_api_key: providerId === "groq" ? cfg.secrets.groq_api_key : "",
      openai_api_key: providerId === "openai" ? cfg.secrets.openai_api_key : "",
    },
  };
}

export function chatRequestBody(system, user, cfg, { temperature, maxTokens, thinking } = {}) {
  // cfg is usually scoped to one provider (see cfgScopedToProvider). Order preference: Groq → NIM → OpenAI.
  const nv = Boolean(cfg?.secrets?.nvidia_api_key);
  let model;
  if (cfg?.secrets?.groq_api_key) model = cfg.ai?.groq_model || "openai/gpt-oss-120b";
  else if (nv) model = cfg.ai?.model || DEFAULT_MODEL;
  else model = "gpt-4o-mini";

  const body = {
    model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: temperature ?? cfg.ai?.temperature ?? 0.3,
    max_tokens: maxTokens ?? cfg.ai?.max_tokens ?? DEFAULT_MAX_TOKENS,
    // Hosted Nemotron buffers stream:false until generation ends (or never). SSE is required.
    stream: nv,
  };

  if (nv) {
    const useThinking = thinking ?? cfg.ai?.enable_thinking !== false;
    if (useThinking) {
      const budget = Number(cfg.ai?.reasoning_budget);
      body.reasoning_budget = Number.isFinite(budget) && budget >= 0 ? budget : DEFAULT_REASONING_BUDGET;
      body.chat_template_kwargs = { enable_thinking: true, reasoning_budget: body.reasoning_budget };
    } else {
      body.chat_template_kwargs = { enable_thinking: false };
    }
  }
  return body;
}

function timeoutError(timeoutMs, provider) {
  return new Error(
    `${provider} timed out after ${timeoutMs}ms while still generating. ` +
      `Raise ai.timeout_ms or lower ai.reasoning_budget.`
  );
}

export function applySseDataLine(raw, acc) {
  const line = String(raw || "").trim();
  if (!line || line === "[DONE]") return acc;
  const ev = JSON.parse(line);
  const d = ev.choices?.[0]?.delta || {};
  if (d.content) acc.content += d.content;
  if (d.reasoning) acc.reasoning += d.reasoning;
  if (d.reasoning_content) acc.reasoning += d.reasoning_content;
  const msg = ev.choices?.[0]?.message;
  if (msg?.content && !d.content) acc.content += msg.content;
  acc.finish = ev.choices?.[0]?.finish_reason || acc.finish;
  return acc;
}

async function readSseContent(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const acc = { content: "", reasoning: "", finish: "" };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      try {
        applySseDataLine(t.slice(5).trim(), acc);
      } catch {
        // ignore a torn JSON chunk; it will complete on a later line
      }
    }
  }
  if (buf.trim().startsWith("data:")) {
    try {
      applySseDataLine(buf.trim().slice(5).trim(), acc);
    } catch {
      // ignore
    }
  }
  if (acc.finish === "length") {
    console.warn("LLM hit max_tokens before the answer finished; raise ai.max_tokens or lower ai.reasoning_budget");
  }
  return acc.content || acc.reasoning || "";
}

export async function chat(system, user, cfg, { temperature, maxTokens, timeoutMs, thinking } = {}) {
  const providers = llmProviders(cfg);
  if (!providers.length) throw new Error("No LLM API key configured");

  const wait = timeoutMs ?? cfg.ai?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const retries = Math.max(0, Number.isFinite(Number(cfg.ai?.retries)) ? Number(cfg.ai.retries) : 1);
  let lastErr;

  for (let pi = 0; pi < providers.length; pi += 1) {
    const p = providers[pi];
    const scoped = cfgScopedToProvider(cfg, p.id);
    const payload = JSON.stringify(
      chatRequestBody(system, user, scoped, { temperature, maxTokens, thinking })
    );

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), wait);
      try {
        const res = await fetch(p.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${p.key}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: payload,
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`${p.name} HTTP ${res.status}: ${text.slice(0, 200)}`);
          if (res.status >= 500 && attempt < retries) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (p.id === "nvidia" && (ct.includes("event-stream") || !ct)) {
          return await readSseContent(res);
        }
        const data = await res.json();
        const msg = data.choices?.[0]?.message || {};
        if (data.choices?.[0]?.finish_reason === "length") {
          console.warn(
            "LLM hit max_tokens before the answer finished; raise ai.max_tokens or lower ai.reasoning_budget"
          );
        }
        if (pi > 0) console.warn(`  LLM fallback ok via ${p.name}`);
        return msg.content || msg.reasoning || "";
      } catch (err) {
        const aborted = err?.name === "AbortError" || /aborted/i.test(err?.message || "");
        lastErr = aborted ? timeoutError(wait, p.name) : err;
        const retryable = aborted || /HTTP 5/.test(String(err?.message || ""));
        if (retryable && attempt < retries) continue;
        break; // try next provider
      } finally {
        clearTimeout(timer);
      }
    }
    if (pi < providers.length - 1) {
      console.warn(`  LLM ${p.name} failed — trying next provider: ${String(lastErr?.message || lastErr).slice(0, 120)}`);
    }
  }
  throw lastErr || new Error("No LLM API key configured");
}

export function makeLlmChat(cfg, opts = {}) {
  if (!llmAvailable(cfg)) return null;
  const timeoutMs = opts.timeoutMs ?? cfg.ai?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? cfg.ai?.max_tokens ?? DEFAULT_MAX_TOKENS;
  return (system, user) => chat(system, user, cfg, {
    temperature: opts.temperature ?? 0.2,
    maxTokens,
    timeoutMs,
    // Form JSON answers must not spend the budget on thinking.
    thinking: opts.thinking ?? false,
  });
}
