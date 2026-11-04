/** Test stand-ins for the Clerk membership check used by plugin-token auth. */
import { and, eq, members, type Db } from '@crunch/db';
import type { MembershipVerifier } from '@/server/services/plugin-tokens';

/** "Clerk agrees with the members mirror." */
export const mirrorVerifier =
  (db: Db): MembershipVerifier =>
  async (_clerkOrgId, userId) => {
    const [m] = await db
      .select({ role: members.role })
      .from(members)
      .where(and(eq(members.userId, userId)))
      .limit(1);
    return m ? { member: true, role: m.role } : { member: false };
  };
