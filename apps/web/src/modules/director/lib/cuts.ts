/** My media's layout: the member's saved cuts, under the template each was made from. */
import type { DirectorCut } from "@repo/contracts/api";

interface TemplateCuts {
  videoId: string;
  title: string;
  /** Newest first, as the API lists them. */
  cuts: DirectorCut[];
}

/** The cuts (newest first) grouped by template, the template cut most recently first. */
export function cutsByTemplate(cuts: readonly DirectorCut[]): TemplateCuts[] {
  const groups = new Map<string, TemplateCuts>();
  for (const cut of cuts) {
    const group = groups.get(cut.videoId) ?? {
      videoId: cut.videoId,
      title: cut.templateTitle,
      cuts: [],
    };
    group.cuts.push(cut);
    groups.set(cut.videoId, group);
  }
  return [...groups.values()];
}

/**
 * The template's Short as YouTube shows it in lists: its own thumbnail, served by YouTube
 * for every public video at this address (the page's CSP allows any https image).
 */
export const templateThumbnail = (videoId: string) =>
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
