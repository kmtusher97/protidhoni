import type { RedisLike } from './types';

export type CacheOptions<TArgs extends unknown[]> = {
  redis: RedisLike;
  prefix: string;
  ttl: number;
  keyBuilder: (...args: TArgs) => string;
};

export function withCache<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: CacheOptions<TArgs>,
): (...args: TArgs) => Promise<TResult> {
  const { redis, prefix, ttl, keyBuilder } = options;

  return async (...args: TArgs): Promise<TResult> => {
    const key = `${prefix}:${keyBuilder(...args)}`;

    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        return JSON.parse(cached) as TResult;
      }
    } catch (err) {
      console.warn(`[protidhoni] Redis GET error for key "${key}":`, err);
    }

    const result = await fn(...args);

    try {
      await redis.setex(key, ttl, JSON.stringify(result));
    } catch (err) {
      console.warn(`[protidhoni] Redis SETEX error for key "${key}":`, err);
    }

    return result;
  };
}
