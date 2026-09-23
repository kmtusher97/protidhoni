import { Readable } from 'stream';

export interface RedisLike {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<string>;
  del(...keys: string[]): Promise<number>;
  scanStream(options: { match: string; count?: number }): Readable;
}
