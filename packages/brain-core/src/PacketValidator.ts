import type { RecommendationPacket, ValidationResult } from '@nemesis/bridge-contracts';
import { validateRecommendationPacket } from '@nemesis/bridge-contracts';
import type { BrainOutputDraft } from './types.js';

export class PacketValidator {
  static toRecommendationPacket(
    draft: BrainOutputDraft,
    options: { now?: number } = {},
  ): ValidationResult<RecommendationPacket> & { packet?: RecommendationPacket } {
    const now = options.now ?? Date.now();
    const packet: RecommendationPacket = {
      ...draft,
      created_at: now,
      expires_at: now + draft.ttl_ms,
    };
    const result = validateRecommendationPacket(packet, { now });
    if (!result.ok) return result;
    return { ...result, packet };
  }
}
