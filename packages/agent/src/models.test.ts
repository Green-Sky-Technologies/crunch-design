import { readFileSync } from 'node:fs';
import { providerModelId } from '@crunch/providers';
import { describe, expect, it } from 'vitest';
import { baseModelId, MODELS } from './models';

// The checked-in snapshot of AI Gateway's Anthropic model ids (packages/providers).
const gatewayIds = (
  JSON.parse(
    readFileSync(
      new URL('../../providers/src/gateway-models.snapshot.json', import.meta.url),
      'utf8',
    ),
  ) as { ids: string[] }
).ids;

describe('model ids across routes', () => {
  it.each(MODELS.map((m) => m.id))('%s exists on AI Gateway and maps back', (id) => {
    const gw = providerModelId('gateway', id);
    expect(gatewayIds).toContain(gw);
    expect(baseModelId(gw)).toBe(id);
    expect(baseModelId(providerModelId('bedrock', id))).toBe(id);
  });
});
