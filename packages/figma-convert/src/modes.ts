/**
 * Figma mode name <-> DesignSystemSpec theme name. Dependency-free: the plugin and the server
 * must normalize mode names identically, or a sync creates duplicate modes ("Dark Mode" vs "dark-mode").
 */

/** "Dark Mode" -> "dark-mode"; null when the name can't be a theme name. */
export function themeName(mode: string): string | null {
  const s = mode
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z][a-z0-9-]*$/.test(s) ? s : null;
}

/** Key used to match a mode name across Figma and CrunchDesign. */
export function modeKey(name: string): string {
  return themeName(name) ?? name.trim().toLowerCase();
}
