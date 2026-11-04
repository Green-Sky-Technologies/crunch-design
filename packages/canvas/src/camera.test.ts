import { describe, expect, it } from 'vitest';
import {
  centerOn,
  clampZoom,
  fitCamera,
  MAX_ZOOM,
  MIN_ZOOM,
  screenToWorld,
  stepZoom,
  wheelCamera,
  worldToScreen,
  zoomAt,
} from './camera';
import { minimapLayout, minimapToWorld } from './minimap';

const wheel = (o: Partial<Parameters<typeof wheelCamera>[1]>) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  ...o,
});

describe('camera', () => {
  it('round-trips screen and world coordinates', () => {
    const c = { x: 120, y: -40, z: 0.5 };
    const p = { x: 333, y: 77 };
    const back = worldToScreen(c, screenToWorld(c, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });

  it('zooms around the pointer, keeping the world point under it fixed', () => {
    const c = { x: 10, y: 20, z: 1 };
    const at = { x: 400, y: 300 };
    const before = screenToWorld(c, at);
    const next = zoomAt(c, at, 2);
    const after = screenToWorld(next, at);
    expect(next.z).toBe(2);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(zoomAt({ x: 0, y: 0, z: 1 }, { x: 0, y: 0 }, 99).z).toBe(MAX_ZOOM);
  });

  it('steps through zoom presets', () => {
    expect(stepZoom(1, 1)).toBe(1.5);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(0.8, -1)).toBe(0.75);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });

  it('pans on wheel and zooms on ctrl/meta wheel (pinch)', () => {
    const c = { x: 0, y: 0, z: 1 };
    expect(wheelCamera(c, wheel({ deltaX: 10, deltaY: 20 }), { x: 0, y: 0 })).toEqual({
      x: -10,
      y: -20,
      z: 1,
    });
    expect(wheelCamera(c, wheel({ deltaY: 30, shiftKey: true }), { x: 0, y: 0 }).x).toBe(-30);
    expect(
      wheelCamera(c, wheel({ deltaY: -100, ctrlKey: true }), { x: 50, y: 50 }).z,
    ).toBeGreaterThan(1);
    expect(wheelCamera(c, wheel({ deltaY: 100, metaKey: true }), { x: 50, y: 50 }).z).toBeLessThan(
      1,
    );
    expect(wheelCamera(c, wheel({ deltaY: 1, deltaMode: 1 }), { x: 0, y: 0 }).y).toBe(-16);
  });

  it('fits bounds into the viewport', () => {
    const c = fitCamera(
      { x: 0, y: 0, width: 2000, height: 1000 },
      { width: 1000, height: 600 },
      50,
    );
    expect(c.z).toBeCloseTo(0.45);
    const tl = worldToScreen(c, { x: 0, y: 0 });
    const br = worldToScreen(c, { x: 2000, y: 1000 });
    expect(tl.x).toBeCloseTo(50);
    expect(br.x).toBeCloseTo(950);
    // never zooms in past maxZoom for small content
    expect(fitCamera({ x: 0, y: 0, width: 10, height: 10 }, { width: 1000, height: 600 }).z).toBe(
      1,
    );
  });

  it('centers on a world point', () => {
    const c = centerOn({ x: 0, y: 0, z: 2 }, { x: 100, y: 100 }, { width: 800, height: 600 });
    expect(worldToScreen(c, { x: 100, y: 100 })).toEqual({ x: 400, y: 300 });
  });
});

describe('minimap', () => {
  it('projects frames and viewport into the box and back', () => {
    const m = minimapLayout(
      [
        { x: 0, y: 0, width: 1000, height: 500 },
        { x: 1200, y: 0, width: 800, height: 500 },
      ],
      { x: 0, y: 0, width: 600, height: 400 },
      { width: 200, height: 100 },
      0,
    );
    expect(m.scale).toBeCloseTo(0.1);
    expect(m.frames[1]!.x).toBeCloseTo(120);
    const w = minimapToWorld(m, { x: 120, y: 50 });
    expect(w.x).toBeCloseTo(1200);
    expect(w.y).toBeCloseTo(250);
  });
});
