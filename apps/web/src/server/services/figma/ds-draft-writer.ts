/**
 * Integration of Story 8.4 (pull) with Epic 4: write a token-sync result into the design-system
 * draft through the design-system service, so its validation, locking and revision rules apply.
 * Publishing stays an explicit step in the design-system editor (drafts never reach projects).
 */
import { saveDesignSystemDraft } from '../design-systems';
import type { DraftWriter } from './token-sync';

export const designSystemDraftWriter: DraftWriter = async (db, actor, designSystemId, spec) => {
  await saveDesignSystemDraft(db, actor, designSystemId, { spec });
};
