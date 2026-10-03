/** Preserve the position already explored; re-rank only upcoming recommendations. */
export function stableFeedOrder(previous, rankedIds, currentId) {
  const ranked = [...new Set(rankedIds)];
  const admitted = new Set(ranked);
  const currentIndex = previous.indexOf(currentId);
  const prefix =
    currentIndex >= 0 ? previous.slice(0, currentIndex + 1).filter((id) => admitted.has(id)) : [];
  const used = new Set(prefix);
  const existing = new Set(previous);
  return [...prefix, ...ranked.filter(id => existing.has(id) && !used.has(id)), ...ranked.filter(id => !existing.has(id))];
}

/** Count only visible playback progress, bounded by elapsed wall-clock time. */
export function watchInterval({
  fromSeconds,
  toSeconds,
  wallSeconds,
  durationSeconds,
  visible,
  foreground,
  playing,
  buffering,
  ready,
  seeking = false
}) {
  if (!visible || !foreground || !playing || buffering || !ready || seeking) return null;
  if (
    ![fromSeconds, toSeconds, wallSeconds, durationSeconds].every(Number.isFinite) ||
    durationSeconds <= 0 ||
    fromSeconds < 0 ||
    wallSeconds <= 0
  )
    return null;
  const delta = toSeconds - fromSeconds;
  if (delta <= 0.05) return null;
  const from = Math.min(durationSeconds, fromSeconds);
  const to = Math.min(durationSeconds, toSeconds, from + wallSeconds);
  if (to <= from) return null;
  return {
    fromSeconds: from,
    toSeconds: to,
    seconds: to - from,
    coverage: (to - from) / durationSeconds,
    foreground: true,
    visible: true,
    playing: true,
    buffering: false,
    ready: true
  };
}

export function playbackSeekSeconds(value, durationSeconds) {
  if (!Number.isFinite(value) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.max(0, Math.min(durationSeconds, value));
}

export function isPlaybackAuthenticationError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b401\b|\bunauthorized\b|(?:token|令牌).*(?:expired|invalid|过期|失效)/i.test(message);
}

export function hasServerRestarted(previous, next) {
  return typeof previous === 'string' && typeof next === 'string' && previous !== next;
}

/** One media-auth recovery per work and server lifetime, across player remounts. */
export class PlaybackRecoveryGate {
  constructor() { this.attempted = new Set(); }
  claim(instanceId, workId, error) {
    if (!workId || !isPlaybackAuthenticationError(error)) return false;
    const key = JSON.stringify([instanceId || 'legacy', workId]);
    if (this.attempted.has(key)) return false;
    this.attempted.add(key);
    if (this.attempted.size > 128) this.attempted.delete(this.attempted.values().next().value);
    return true;
  }
}
