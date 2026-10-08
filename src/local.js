import { LOCAL_SYSTEM } from '../configuration/prompts.js';
import { LOCAL_LLM } from '../configuration/settings.js';
import { NeuronsError, redact } from './guard.js';

/*
 * Client for a model server running on this machine (Ollama, LM Studio, or
 * anything with the OpenAI-compatible /v1 API). Nothing here sends an API key,
 * and a URL that is not loopback is refused, so questions and notes never
 * leave the computer.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function localBase() {
  let url;
  try {
    url = new URL(LOCAL_LLM.url);
  } catch {
    throw new NeuronsError(`NEURONS_LLM_URL is not a URL: ${LOCAL_LLM.url}`);
  }
  if (!LOOPBACK.has(url.hostname)) throw new NeuronsError(`NEURONS_LLM_URL must point at this machine (localhost), not ${url.hostname}.`);
  return url.href.replace(/\/+$/, '');
}

async function post(route, body, timeoutMs) {
  const res = await fetch(`${localBase()}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${route} returned ${res.status}`);
  return res.json();
}

let probe = { at: 0, models: null };

// Model ids the local server offers, or null when it is not running; cached briefly so each call does not pay for it
export async function localModels() {
  if (Date.now() - probe.at < LOCAL_LLM.probeCacheMs) return probe.models;
  let models = null;
  try {
    const res = await fetch(`${localBase()}/models`, { signal: AbortSignal.timeout(LOCAL_LLM.probeTimeoutMs) });
    if (res.ok) models = ((await res.json()).data || []).map((m) => m.id);
  } catch (err) {
    if (err instanceof NeuronsError) throw err;
  }
  probe = { at: Date.now(), models };
  return models;
}

// Ollama lists "name:tag"; a model asked for without a tag is ":latest"
export const hasModel = (models, name) => !!models && models.some((m) => m === name || m === `${name}:latest`);

// One answer from the local chat model, or null when it says it does not know
export async function askLocal(question) {
  const data = await post(
    '/chat/completions',
    {
      model: LOCAL_LLM.model,
      messages: [
        { role: 'system', content: LOCAL_SYSTEM },
        { role: 'user', content: question },
      ],
      temperature: 0.2,
      max_tokens: LOCAL_LLM.maxTokens,
      stream: false,
    },
    LOCAL_LLM.timeoutMs,
  );
  // Reasoning models put their thinking in <think> tags; only the answer is passed on
  const text = String(data.choices?.[0]?.message?.content || '')
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim();
  if (!text || /^unknown\b/i.test(text)) return null;
  return redact(text);
}

export async function embed(model, texts, timeoutMs) {
  const data = await post('/embeddings', { model, input: texts }, timeoutMs);
  const rows = [...(data.data || [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (rows.length !== texts.length) throw new Error(`embeddings returned ${rows.length} vectors for ${texts.length} inputs`);
  return rows.map((r) => r.embedding);
}
