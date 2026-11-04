import { pgEnum } from 'drizzle-orm/pg-core';

/** Who made a change. Agent changes are attributed to the requesting user via actorId. */
export const actorTypeEnum = pgEnum('actor_type', ['user', 'agent', 'system']);

/** Where a DesignDoc transaction came from (cost/attribution analytics, activity feed). */
export const opSourceEnum = pgEnum('op_source', [
  'canvas',
  'inspector',
  'slider',
  'agent',
  'restore',
  'import',
  'system',
]);
