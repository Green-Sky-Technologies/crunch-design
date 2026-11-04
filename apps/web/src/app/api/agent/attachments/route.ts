/**
 * POST /api/agent/attachments (multipart: projectId, file) -> { url }
 * Uploads an image for a chat message to Vercel Blob and records it in `assets`.
 * The URL is unguessable (random suffix) and public so the model provider can fetch it.
 */
import { assertCan } from '@crunch/authz';
import { assets, getDb } from '@crunch/db';
import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { apiActor, apiError } from '@/server/api';
import { getProject } from '@/server/services/projects';
import { ValidationError } from '@/server/services/types';

const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024;

export async function POST(req: Request) {
  try {
    const actor = await apiActor();
    assertCan(actor.role, 'agent:run');
    if (!process.env.BLOB_READ_WRITE_TOKEN)
      return NextResponse.json(
        { error: 'unavailable', message: 'Image uploads are not configured.' },
        { status: 501 },
      );
    const form = await req.formData();
    const projectId = String(form.get('projectId') ?? '');
    const file = form.get('file');
    const project = await getProject(getDb(), actor, projectId);
    if (!(file instanceof File)) throw new ValidationError('Missing file');
    if (!TYPES.has(file.type)) throw new ValidationError('Only PNG, JPEG, WebP or GIF images');
    if (file.size > MAX_BYTES) throw new ValidationError('Images must be 5 MB or smaller');
    const ext = file.type.split('/')[1];
    const blob = await put(`agent/${actor.workspace.id}/${project.id}/attachment.${ext}`, file, {
      access: 'public',
      addRandomSuffix: true,
      contentType: file.type,
    });
    await getDb().insert(assets).values({
      workspaceId: actor.workspace.id,
      projectId: project.id,
      kind: 'upload',
      blobUrl: blob.url,
      pathname: blob.pathname,
      contentType: file.type,
      sizeBytes: file.size,
      createdBy: actor.userId,
    });
    return NextResponse.json({ url: blob.url });
  } catch (e) {
    return apiError(e);
  }
}
