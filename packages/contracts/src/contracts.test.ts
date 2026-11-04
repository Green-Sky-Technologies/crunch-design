import { sampleLandingDoc } from '@crunch/doc-model';
import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, agentEditRequest, jobInputs, toolsFor } from './index';

describe('contracts', () => {
  it('tool lists are stable and runtime-filtered', () => {
    const interactive = toolsFor('interactive').map((t) => t.name);
    expect(interactive).toEqual([...interactive].sort());
    expect(interactive).not.toContain('capture_url');
    expect(toolsFor('job').map((t) => t.name)).toContain('screenshot_frame');
  });

  it('patch_nodes validates ops with the doc-model schema', () => {
    const ok = AGENT_TOOLS.patch_nodes.input.safeParse({
      label: 'x',
      ops: [
        { op: 'setStyle', id: 'n_herotitle1', breakpoint: 'base', prop: 'color', value: '#fff' },
      ],
    });
    expect(ok.success).toBe(true);
    expect(
      AGENT_TOOLS.patch_nodes.input.safeParse({ label: 'x', ops: [{ op: 'nuke' }] }).success,
    ).toBe(false);
  });

  it('insert_frame accepts frames from the sample doc', () => {
    const doc = sampleLandingDoc();
    const f = doc.frames[0]!;
    const nodes = Object.values(doc.nodes);
    expect(
      AGENT_TOOLS.insert_frame.input.safeParse({ frame: { ...f, canvas: undefined }, nodes })
        .success,
    ).toBe(true);
  });

  it('job inputs and agent edit requests validate', () => {
    expect(jobInputs.generate.parse({ prompt: 'A pricing page' })).toEqual({
      prompt: 'A pricing page',
      frameCount: 1,
    });
    expect(jobInputs.web_capture.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(
      agentEditRequest.safeParse({
        projectId: crypto.randomUUID(),
        frameId: 'f_x',
        nodeId: 'n_x',
        prompt: 'bigger',
      }).success,
    ).toBe(true);
  });
});
