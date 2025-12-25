export interface AudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
  bytesPerSecond: number;
}

export class WASAPICapture {
  constructor(callback: (data: Buffer) => void);
  start(): boolean;
  stop(): void;
  getFormat(): AudioFormat | null;
}









