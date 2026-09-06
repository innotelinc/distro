import type { ModelInfo } from './types';

/**
 * Distro: gateway (OmniRoute) model catalogs mix chat, image, embedding,
 * audio/video and rerank models. Upstream bolt.diy falls back to
 * modelsList[0] when the requested model id is missing — but on a gateway
 * catalog the first entry can be an image-generation model (e.g.
 * 'aihorde/2DN'), which hard-fails /v1/chat/completions. These helpers prefer
 * a plausibly chat-capable model instead.
 */
const NON_CHAT_MODEL_HINTS =
  /(image|img-|-2dn|-2d\b|embed|rerank|tts|speech|audio|asr|whisper|video|moderation|dall-e|sdxl|flux|stable-diffusion|paint|remove-bg|ocr)/i;

export function isLikelyChatModel(id: string): boolean {
  return !NON_CHAT_MODEL_HINTS.test(id);
}

export function pickFirstChatModel(models: ModelInfo[]): ModelInfo | undefined {
  return models.find((m) => m.name && isLikelyChatModel(m.name)) || models[0];
}
