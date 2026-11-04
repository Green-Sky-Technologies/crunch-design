/** Browser client for named versions (Story 6.2). */
import type { DesignDoc } from '@crunch/doc-model';
import { request } from './api';

export interface VersionItem {
  id: string;
  kind: 'auto' | 'named';
  name: string | null;
  description: string | null;
  docVersion: number;
  restoredFromId: string | null;
  createdBy: string;
  createdByName: string | null;
  createdAt: string;
}

export const versionsApi = {
  list: (projectId: string, includeAuto: boolean) =>
    request<{ versions: VersionItem[] }>(
      `/api/versions?projectId=${encodeURIComponent(projectId)}${includeAuto ? '&includeAuto=1' : ''}`,
    ),
  create: (projectId: string, name: string, description: string) =>
    request<{ version: VersionItem }>('/api/versions', {
      method: 'POST',
      json: { projectId, name, description: description || undefined },
    }),
  get: (projectId: string, id: string) =>
    request<{ version: VersionItem; doc: DesignDoc }>(
      `/api/versions/${id}?projectId=${encodeURIComponent(projectId)}`,
    ),
  restore: (projectId: string, id: string) =>
    request<{ version: number; backupId: string }>(`/api/versions/${id}/restore`, {
      method: 'POST',
      json: { projectId },
    }),
};

export const versionLabel = (v: VersionItem) =>
  v.kind === 'named'
    ? (v.name ?? 'Untitled version')
    : v.restoredFromId
      ? 'Auto backup before restore'
      : 'Auto snapshot';
