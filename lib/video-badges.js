// Prefer the API's display text: early-access labels can change after release.
export function getVideoBadges(video) {
  const text = video.elec_arc_badge?.text;
  if (typeof text === 'string' && text.trim()) {
    return [text.trim().slice(0, 40)];
  }

  const enabled = value => value === true || value === 1 || value === '1';
  if (enabled(video.is_upower_exclusive) || enabled(video.is_charging_union)) {
    return ['充电专属'];
  }
  return [];
}
