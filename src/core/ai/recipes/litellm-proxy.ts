import type { Recipe } from '../types.ts';

/**
 * LiteLLM proxy template. Users run LiteLLM in front of any provider
 * (Bedrock, Vertex, Azure, Fireworks, Together, DeepSeek, etc.) and point
 * gbrain at it via `LITELLM_BASE_URL`. The proxy normalizes to
 * OpenAI-compatible API.
 *
 * See docs/guides/litellm-proxy.md for the setup recipe.
 */
export const litellmProxy: Recipe = {
  id: 'litellm',
  name: 'LiteLLM Proxy (universal)',
  tier: 'openai-compat',
  implementation: 'openai-compatible',
  base_url_default: 'http://localhost:4000', // LiteLLM default
  auth_env: {
    required: [], // LITELLM_API_KEY is optional (users may run proxy unauthenticated locally)
    optional: ['LITELLM_BASE_URL', 'LITELLM_API_KEY'],
    setup_url: 'https://docs.litellm.ai/docs/proxy/quick_start',
  },
  touchpoints: {
    embedding: {
      // Models depend on the proxy's config; declare empties so wizard prompts user.
      models: [],
      user_provided_models: true, // v0.32 D8=A wire-through for the litellm hardcode
      default_dims: 0, // user must declare --embedding-dimensions explicitly
      cost_per_1m_tokens_usd: undefined,
      price_last_verified: '2026-04-20',
      // LiteLLM's batch capacity is determined by the backend it proxies;
      // no static cap to declare here. v0.32 (#779).
      no_batch_cap: true,
      // v0.34.1 (#875): LiteLLM can forward to multimodal providers (OpenAI,
      // Gemini, Voyage etc.). embedMultimodal routes openai-compatible
      // recipes through embedMultimodalOpenAICompat() — same /embeddings
      // endpoint as text, with content arrays carrying image_base64
      // entries. No multimodal_models allow-list: the user knows which of
      // their proxied models support multimodal; we trust the model id and
      // surface the provider's rejection (D12 dim-validation catches
      // mismatched-dim responses pre-storage).
      supports_multimodal: true,
    },
    // v0.42.47.0 (PR-6 / A1): chat + expansion + reranker touchpoints so the
    // LiteLLM proxy can be the SINGLE on-prem inference endpoint for ALL four
    // gbrain touchpoints, not embedding-only. Without these declared, the
    // model-resolver's assertTouchpoint() throws for `litellm:*` chat/expansion/
    // reranker, so the A2/A24/A3 deploy-config pins (`gbrain config set
    // chat_model litellm:<m>` etc.) were inert. Models are user-provided (the
    // proxy decides what it forwards), matching the embedding touchpoint above;
    // litellm is `tier: 'openai-compat'`, so assertTouchpoint does NOT enforce
    // the (empty) model allowlist. UNCONDITIONAL — additive to every install,
    // no cloud regression (nobody is forced onto litellm by this).
    chat: {
      models: [], // user-provided; the proxy's config decides the backend
      supports_tools: true,
      supports_subagent_loop: true,
      // Prompt-cache + context window + price depend on the proxied backend; the
      // user knows their model. Left unset rather than guessed.
      supports_prompt_cache: false,
    },
    expansion: {
      models: [], // user-provided; whatever the proxy forwards expansion to
    },
    reranker: {
      models: [], // user-provided via `search.reranker.model litellm:<id>`
      // Informational only (wizard/docs copy); the real id is the config pin.
      // No runtime consumer reads default_model — set descriptively.
      default_model: 'user-provided',
      // LiteLLM's per-request cap depends on the backend; mirror the local
      // reranker recipe's defensive ceiling rather than declare unbounded.
      max_payload_bytes: 5_000_000,
      // base_url_default ('http://localhost:4000') has no '/v1' suffix, so the
      // leaf path is the full '/v1/rerank' LiteLLM exposes (gateway concatenates
      // `${base_url}${path}`). LiteLLM also serves bare '/rerank'.
      path: '/v1/rerank',
    },
  },
  setup_hint: 'Run LiteLLM (https://docs.litellm.ai) in front of any provider; set LITELLM_BASE_URL + pass --embedding-model litellm:<model> and --embedding-dimensions <N>. For a single on-prem proxy, also pin chat/expansion/reranker: `gbrain config set chat_model litellm:<m>`, `expansion_model litellm:<m>`, `search.reranker.model litellm:<m>`.',
};
