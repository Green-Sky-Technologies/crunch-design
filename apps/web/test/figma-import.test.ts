/**
 * Import from Figma (Story 8.3): Figma token storage, REST import with a mocked Figma API, plugin
 * import, permissions, and that imports land as an 'import' transaction producing a valid doc.
 * No real Figma calls: `fetch` is injected.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ForbiddenError } from '@crunch/authz';
import { generateMasterKey, parseKeyring } from '@crunch/crypto';
import { docOps, eq, figmaCredentials, figmaLinks } from '@crunch/db';
import { parseDoc } from '@crunch/doc-model';
import { getDoc } from '@/server/services/design-docs';
import { importFigmaNodes, importFigmaUrl } from '@/server/services/figma';
import {
  aadForFigma,
  deleteFigmaToken,
  getFigmaCredential,
  loadFigmaToken,
  saveFigmaToken,
} from '@/server/services/figma/credentials';
import { isAllowedAssetUrl, parseFigmaUrl, type FigmaFetch } from '@/server/services/figma/rest';
import { importRequest } from '@/server/services/figma/schemas';
import { createProject } from '@/server/services/projects';
import { NotFoundError, ValidationError, type Actor } from '@/server/services/types';
import { makeActor, reset, testDb } from './helpers';

const { db, close } = testDb();
afterAll(close);
beforeEach(() => reset(db));

const keyring = parseKeyring(`t1:${generateMasterKey()}`);
const TOKEN = 'figd_' + 'x'.repeat(30) + 'ABCD';
const FILE = 'AbCdEfGhIjKl1234';

const frameNode = {
  id: '1:2',
  name: 'Hero',
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 800, height: 400 },
  layoutMode: 'VERTICAL',
  primaryAxisSizingMode: 'FIXED',
  counterAxisSizingMode: 'FIXED',
  itemSpacing: 16,
  paddingTop: 32,
  paddingBottom: 32,
  paddingLeft: 32,
  paddingRight: 32,
  fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
  children: [
    {
      id: '1:3',
      name: 'Headline',
      type: 'TEXT',
      characters: 'Hello from Figma',
      style: { fontFamily: 'Inter', fontWeight: 700, fontSize: 36 },
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
      boundVariables: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:9:9' }] },
    },
    {
      id: '1:4',
      name: 'Logo',
      type: 'VECTOR',
      absoluteBoundingBox: { x: 32, y: 120, width: 24, height: 24 },
    },
    {
      id: '1:5',
      name: 'Photo',
      type: 'RECTANGLE',
      absoluteBoundingBox: { x: 32, y: 160, width: 300, height: 200 },
      fills: [{ type: 'IMAGE', imageRef: 'img1', scaleMode: 'FIT' }],
    },
  ],
};

/** A fake Figma API. Records requested URLs; never touches the network. */
function fakeFigma(opts: { variables403?: boolean } = {}) {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher: FigmaFetch = async (url, init) => {
    calls.push(url);
    const headers = new Headers(init?.headers);
    if (url.startsWith('https://api.figma.com') && headers.get('x-figma-token') !== TOKEN)
      return json({ err: 'forbidden' }, 403);
    const u = new URL(url);
    if (u.pathname === '/v1/me') return json({ handle: 'designer', email: 'd@example.com' });
    if (u.pathname === `/v1/files/${FILE}/nodes`)
      return json({ name: 'Marketing', nodes: { '1:2': { document: frameNode } } });
    if (u.pathname === `/v1/files/${FILE}`)
      return json({
        name: 'Marketing',
        document: {
          children: [
            {
              children: [
                { id: '1:2', type: 'FRAME' },
                { id: '1:9', type: 'TEXT' },
              ],
            },
          ],
        },
      });
    if (u.pathname === `/v1/images/${FILE}`)
      return json({
        images: { '1:4': 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/logo.svg' },
      });
    if (u.hostname.endsWith('amazonaws.com'))
      return new Response(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0h24v24H0z" onclick="x()"/></svg>',
      );
    if (u.pathname === `/v1/files/${FILE}/images`)
      return json({ meta: { images: { img1: 'https://s3-alpha-sig.figma.com/img/aa/bb' } } });
    if (u.pathname === `/v1/files/${FILE}/variables/local`)
      return opts.variables403
        ? json({}, 403)
        : json({ meta: { variables: { 'VariableID:9:9': { name: 'text/4xl' } } } });
    return json({}, 404);
  };
  return { fetcher, calls };
}

async function editorWithProject(): Promise<{ actor: Actor; projectId: string }> {
  const actor = await makeActor(db, 'editor');
  const p = await createProject(db, actor, { name: 'Imports' });
  return { actor, projectId: p.id };
}

describe('Figma token', () => {
  it('verifies, encrypts bound to workspace+user, and never returns the token', async () => {
    const { actor } = await editorWithProject();
    const { fetcher } = fakeFigma();
    const pub = await saveFigmaToken(db, actor, TOKEN, { keyring, fetch: fetcher });
    expect(pub).toMatchObject({ hint: '…ABCD', figmaUserHandle: 'designer' });
    expect(JSON.stringify(pub)).not.toContain(TOKEN);
    const [row] = await db
      .select()
      .from(figmaCredentials)
      .where(eq(figmaCredentials.userId, actor.userId));
    expect(row!.tokenEnvelope).not.toContain(TOKEN);
    expect(await loadFigmaToken(db, actor, keyring)).toBe(TOKEN);

    // Another member of the same workspace can't use it (AAD includes the user id).
    const other = await makeActor(db, 'editor', actor.workspace);
    await expect(loadFigmaToken(db, other, keyring)).rejects.toThrow(NotFoundError);
    expect(aadForFigma('w', 'u')).toBe('figma_credential:w:u');

    expect(await getFigmaCredential(db, actor)).toMatchObject({ hint: '…ABCD' });
    await deleteFigmaToken(db, actor);
    expect(await getFigmaCredential(db, actor)).toBeNull();
  });

  it('rejects malformed tokens, tokens Figma refuses, and viewers', async () => {
    const { actor } = await editorWithProject();
    const { fetcher } = fakeFigma();
    await expect(saveFigmaToken(db, actor, 'short', { keyring, fetch: fetcher })).rejects.toThrow(
      ValidationError,
    );
    await expect(
      saveFigmaToken(db, actor, 'figd_' + 'y'.repeat(30), { keyring, fetch: fetcher }),
    ).rejects.toThrow(/rejected/);
    const viewer = await makeActor(db, 'viewer', actor.workspace);
    await expect(saveFigmaToken(db, viewer, TOKEN, { keyring, fetch: fetcher })).rejects.toThrow(
      ForbiddenError,
    );
  });
});

describe('Figma URLs', () => {
  it('parses file and frame links and rejects other hosts', () => {
    expect(parseFigmaUrl(`https://www.figma.com/design/${FILE}/Marketing?node-id=1-2&t=x`)).toEqual(
      { fileKey: FILE, nodeIds: ['1:2'] },
    );
    expect(parseFigmaUrl(`https://figma.com/file/${FILE}/x`)).toEqual({
      fileKey: FILE,
      nodeIds: [],
    });
    expect(() => parseFigmaUrl('https://evil.example/design/abc')).toThrow(ValidationError);
    expect(() => parseFigmaUrl(`http://www.figma.com/design/${FILE}`)).toThrow(ValidationError);
    expect(() => parseFigmaUrl('not a url')).toThrow(ValidationError);
    expect(isAllowedAssetUrl('https://figma-alpha-api.s3.us-west-2.amazonaws.com/a.svg')).toBe(
      true,
    );
    expect(isAllowedAssetUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isAllowedAssetUrl('https://internal.example/a.svg')).toBe(false);
  });
});

describe('import from a Figma URL (REST)', () => {
  it('inserts frames as one import transaction with a fidelity report', async () => {
    const { actor, projectId } = await editorWithProject();
    const { fetcher, calls } = fakeFigma();
    await saveFigmaToken(db, actor, TOKEN, { keyring, fetch: fetcher });
    const res = await importFigmaUrl(
      db,
      actor,
      projectId,
      `https://www.figma.com/design/${FILE}/M?node-id=1-2`,
      { keyring, fetch: fetcher },
    );

    expect(res.version).toBe(1);
    expect(res.frames).toEqual([expect.objectContaining({ name: 'Hero', width: 800 })]);
    expect(res.stats).toMatchObject({ svgs: 1, images: 1 });
    expect(res.report.some((r) => /expire/.test(r.message))).toBe(true);
    // Only Figma hosts were contacted.
    expect(calls.every((u) => isAllowedAssetUrl(u))).toBe(true);

    const { doc } = await getDoc(db, actor, projectId);
    expect(() => parseDoc(doc)).not.toThrow();
    expect(doc.frames.map((f) => f.name)).toEqual(['Desktop', 'Hero']);
    const hero = doc.frames[1]!;
    expect(hero.canvas.x).toBeGreaterThanOrEqual(1280); // placed right of the existing frame
    const nodes = Object.values(doc.nodes);
    const headline = nodes.find((n) => n.name === 'Headline')!;
    expect(headline.style.base?.fontSize).toEqual({ token: 'text.4xl' }); // bound variable -> token
    const logo = nodes.find((n) => n.name === 'Logo')!;
    expect(logo.type).toBe('svg');
    expect(JSON.stringify(logo)).not.toContain('onclick'); // sanitized
    expect(nodes.find((n) => n.name === 'Photo')).toMatchObject({
      type: 'image',
      style: { base: { objectFit: 'contain' } },
    });

    const [op] = await db.select().from(docOps).where(eq(docOps.projectId, projectId));
    expect(op).toMatchObject({ source: 'import', actorId: actor.userId });
    const [link] = await db.select().from(figmaLinks).where(eq(figmaLinks.projectId, projectId));
    expect(link).toMatchObject({
      direction: 'import',
      figmaFileKey: FILE,
      figmaFileName: 'Marketing',
    });
  });

  it('imports the first page’s top frames when the link has no node id, and degrades without variables', async () => {
    const { actor, projectId } = await editorWithProject();
    const { fetcher } = fakeFigma({ variables403: true });
    await saveFigmaToken(db, actor, TOKEN, { keyring, fetch: fetcher });
    const res = await importFigmaUrl(db, actor, projectId, `https://www.figma.com/file/${FILE}/M`, {
      keyring,
      fetch: fetcher,
    });
    expect(res.frames).toHaveLength(1);
    expect(res.report.some((r) => r.subject === 'variables')).toBe(true);
  });

  it('dry run converts without saving (prompt reference) and viewers can only dry-run', async () => {
    const { actor, projectId } = await editorWithProject();
    const { fetcher } = fakeFigma();
    const viewer = await makeActor(db, 'viewer', actor.workspace);
    await saveFigmaToken(db, actor, TOKEN, { keyring, fetch: fetcher });
    const res = await importFigmaUrl(
      db,
      actor,
      projectId,
      `https://www.figma.com/design/${FILE}/M?node-id=1-2`,
      { keyring, fetch: fetcher, dryRun: true },
    );
    expect(res.version).toBeNull();
    expect(res.preview?.[0]?.nodes.length).toBeGreaterThan(1);
    expect((await getDoc(db, actor, projectId)).version).toBe(0);
    await expect(
      importFigmaUrl(db, viewer, projectId, `https://www.figma.com/design/${FILE}/M`, {
        keyring,
        fetch: fetcher,
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('requires a stored token and a project in the caller’s workspace', async () => {
    const { actor, projectId } = await editorWithProject();
    const { fetcher } = fakeFigma();
    await expect(
      importFigmaUrl(db, actor, projectId, `https://www.figma.com/design/${FILE}/M`, {
        keyring,
        fetch: fetcher,
      }),
    ).rejects.toThrow(/Figma token/);
    const outsider = await makeActor(db, 'editor');
    await expect(
      importFigmaUrl(db, outsider, projectId, `https://www.figma.com/design/${FILE}/M`, {
        keyring,
        fetch: fetcher,
      }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('import from the plugin', () => {
  it('validates the payload and inserts frames', async () => {
    const { actor, projectId } = await editorWithProject();
    const body = importRequest.parse({
      fileKey: 'local:0b9f3f9e-7d1f-4a51-9f0c-5f5c3f0b1a2b',
      fileName: 'Local',
      nodes: [frameNode],
      svgs: { '1:4': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>' },
      images: { img1: 'data:image/png;base64,iVBORw0KGgo=' },
      variables: { 'VariableID:9:9': 'text/4xl' },
    });
    const res = await importFigmaNodes(db, actor, projectId, { ...body, source: 'plugin' });
    expect(res.stats).toMatchObject({ svgs: 1, images: 1 });
    expect(res.stats.tokens).toBeGreaterThan(0);
    const { doc } = await getDoc(db, actor, projectId);
    expect(() => parseDoc(doc)).not.toThrow();

    await expect(
      importFigmaNodes(db, actor, projectId, { nodes: [{ id: 1 }], source: 'plugin' }),
    ).rejects.toThrow(/Invalid Figma nodes/);
    expect(importRequest.safeParse({ nodes: [], svgs: {} }).success).toBe(false);
    const viewer = await makeActor(db, 'viewer', actor.workspace);
    await expect(
      importFigmaNodes(db, viewer, projectId, { ...body, source: 'plugin' }),
    ).rejects.toThrow(ForbiddenError);
  });
});
