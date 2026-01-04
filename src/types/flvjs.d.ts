declare module 'flv.js' {
  export interface FlvPlayer {
    attachMediaElement(mediaElement: HTMLMediaElement): void;
    detachMediaElement(): void;
    load(): void;
    unload(): void;
    destroy(): void;
    pause(): void;
  }

  export interface CreatePlayerConfig {
    type: 'flv';
    url: string;
    isLive?: boolean;
    hasAudio?: boolean;
    hasVideo?: boolean;
  }

  export interface CreatePlayerOptions {
    enableWorker?: boolean;
    enableStashBuffer?: boolean;
    stashInitialSize?: number;
  }

  export function isSupported(): boolean;
  export function createPlayer(
    config: CreatePlayerConfig,
    options?: CreatePlayerOptions,
  ): FlvPlayer;

  const flvjs: {
    isSupported: typeof isSupported;
    createPlayer: typeof createPlayer;
  };

  export default flvjs;
}
