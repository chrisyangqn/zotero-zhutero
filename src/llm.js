/**
 * LLM API abstraction - supports Anthropic and OpenAI-compatible endpoints.
 */

const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    models: [
      { id: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ],
    defaultModel: "claude-sonnet-4-20250514",
  },
  openai: {
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4o", label: "GPT-4o" },
      { id: "gpt-4o-mini", label: "GPT-4o Mini" },
    ],
    defaultModel: "gpt-4o",
  },
  custom: {
    name: "Custom (OpenAI-compatible)",
    baseUrl: "",
    models: [],
    defaultModel: "",
  },
};

function getPrefs() {
  const prefs = Components.classes["@mozilla.org/preferences-service;1"]
    .getService(Components.interfaces.nsIPrefBranch);
  return {
    provider: prefs.getStringPref("extensions.zhutero.provider", "anthropic"),
    apiKey: prefs.getStringPref("extensions.zhutero.apiKey", ""),
    model: prefs.getStringPref("extensions.zhutero.model", ""),
    baseUrl: prefs.getStringPref("extensions.zhutero.baseUrl", ""),
  };
}

function getActiveModel() {
  const { provider, model } = getPrefs();
  if (model) return model;
  return PROVIDERS[provider]?.defaultModel || "";
}

function getActiveBaseUrl() {
  const { provider, baseUrl } = getPrefs();
  if (provider === "custom") return baseUrl;
  return PROVIDERS[provider]?.baseUrl || "";
}

/**
 * Send a chat completion request to the configured LLM provider.
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} opts - { maxTokens }
 * @returns {Promise<{ text: string, usage: object }>}
 */
async function chatCompletion(systemPrompt, userMessage, opts = {}) {
  const { provider, apiKey } = getPrefs();
  const model = getActiveModel();
  const baseUrl = getActiveBaseUrl();
  const maxTokens = opts.maxTokens || 16000;

  if (!apiKey) throw new Error("No API key configured.");
  if (!model) throw new Error("No model configured.");

  Zotero.debug(`[Zhutero/LLM] → ${provider} model=${model} maxTokens=${maxTokens} ` +
    `system=${systemPrompt.length}c user=${userMessage.length}c`);
  const t0 = Date.now();

  let result;
  try {
    if (provider === "anthropic") {
      result = await anthropicChat(baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens);
    } else {
      result = await openaiChat(baseUrl, apiKey, model, systemPrompt, userMessage, maxTokens);
    }
  } catch (e) {
    Zotero.debug(`[Zhutero/LLM] ✗ failed after ${Date.now() - t0}ms: ${e.message}`);
    throw e;
  }

  Zotero.debug(`[Zhutero/LLM] ← ${Date.now() - t0}ms response=${result.text.length}c ` +
    `tokens=${JSON.stringify(result.usage)}`);
  return result;
}

async function anthropicChat(baseUrl, apiKey, model, system, user, maxTokens) {
  const resp = await fetch(`${baseUrl}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Anthropic API error: ${resp.status}`);
  }

  const data = await resp.json();
  return {
    text: data.content[0].text,
    usage: data.usage || {},
  };
}

async function openaiChat(baseUrl, apiKey, model, system, user, maxTokens) {
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error: ${resp.status}`);
  }

  const data = await resp.json();
  return {
    text: data.choices[0].message.content,
    usage: data.usage || {},
  };
}

if (typeof module !== "undefined") {
  module.exports = { PROVIDERS, chatCompletion, getPrefs, getActiveModel };
}
