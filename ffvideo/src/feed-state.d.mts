export function stableFeedOrder(
  previous: string[],
  rankedIds: string[],
  currentId: string
): string[];
export function watchInterval(input: {
  fromSeconds: number;
  toSeconds: number;
  wallSeconds: number;
  durationSeconds: number;
  visible: boolean;
  foreground: boolean;
  playing: boolean;
  buffering: boolean;
  ready: boolean;
  seeking?: boolean;
}): null | {
  fromSeconds: number;
  toSeconds: number;
  seconds: number;
  coverage: number;
  foreground: true;
  visible: true;
  playing: true;
  buffering: false;
  ready: true;
};
export function playbackSeekSeconds(value: number, durationSeconds: number): number | null;
export function isPlaybackAuthenticationError(error: unknown): boolean;
export function hasServerRestarted(previous?: string, next?: string): boolean;
export class PlaybackRecoveryGate {
  claim(instanceId: string | undefined, workId: string, error: unknown): boolean;
}
