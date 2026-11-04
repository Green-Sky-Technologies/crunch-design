/**
 * CrunchDesign Figma plugin, main thread. Skeleton created by foundation; owned by
 * stream-figma (Epic 8). All writes into Figma happen here (the REST API can't create nodes).
 */
figma.showUI(__html__, { width: 360, height: 480, themeColors: true });

figma.ui.onmessage = (msg: { type: string }) => {
  if (msg.type === 'close') figma.closePlugin();
};
