import type { RedisLike } from './types';

// Injected rather than a concrete BullMQ import so this package stays queue-library-agnostic,
// same as RedisLike keeps it ioredis-agnostic. The caller supplies an `enqueue` that hands the
// resolved keys/prefixes to whatever queue it wired up.
export type WorkerInvalidationConfig<TPayload> = {
  enqueue: (payload: TPayload) => Promise<void>;
};

export type InvalidationOptions<TArgs extends unknown[]> = {
  redis: RedisLike;
  prefix: string;
  keyBuilder: (...args: TArgs) => string | string[];
  refetch?: (...args: TArgs) => Promise<unknown>;
  worker?: WorkerInvalidationConfig<string[]>;
};

export async function invalidateCacheKeys(
  redis: RedisLike,
  keys: string[],
): Promise<void> {
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

export function withCacheInvalidation<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: InvalidationOptions<TArgs>,
): (...args: TArgs) => Promise<TResult> {
  const { redis, prefix, keyBuilder, refetch, worker } = options;

  return async (...args: TArgs): Promise<TResult> => {
    const result = await fn(...args);

    const built = keyBuilder(...args);
    const keys = Array.isArray(built) ? built : [`${prefix}:${built}`];

    if (worker) {
      // The worker owns invalidation timing now, so re-warming here would race the deferred
      // delete and get clobbered the moment the worker runs — skip refetch in this mode.
      try {
        await worker.enqueue(keys);
      } catch (err) {
        console.warn(
          `[protidhoni] Failed to enqueue invalidation for keys "${keys.join(', ')}":`,
          err,
        );
      }
      return result;
    }

    try {
      await invalidateCacheKeys(redis, keys);
      if (refetch) {
        refetch(...args).catch((err) => {
          console.warn(
            `[protidhoni] Cache re-warm error for keys "${keys.join(', ')}":`,
            err,
          );
        });
      }
    } catch (err) {
      console.warn(
        `[protidhoni] Redis DEL error for keys "${keys.join(', ')}":`,
        err,
      );
    }

    return result;
  };
}

export type InvalidationByPrefixOptions = {
  redis: RedisLike;
  prefix: string;
  worker?: WorkerInvalidationConfig<string[]>;
};

async function invalidateByPrefix(
  redis: RedisLike,
  prefix: string,
): Promise<void> {
  const allKeys: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const stream = redis.scanStream({
      match: `${prefix}:*`,
      count: 100,
    });

    stream.on('data', (keys: string[]) => {
      if (keys.length > 0) {
        allKeys.push(...keys);
      }
    });

    stream.on('end', () => resolve());
    stream.on('error', (err: Error) => reject(err));
  });

  if (allKeys.length > 0) {
    await redis.del(...allKeys);
  }
}

export async function invalidateCachePrefixes(
  redis: RedisLike,
  prefixes: string[],
): Promise<void> {
  await Promise.all(prefixes.map((p) => invalidateByPrefix(redis, p)));
}

export type InvalidationByPrefixesOptions = {
  redis: RedisLike;
  prefixes: string[];
  worker?: WorkerInvalidationConfig<string[]>;
};

export function withCacheInvalidationByPrefix<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: InvalidationByPrefixOptions,
): (...args: TArgs) => Promise<TResult> {
  return withCacheInvalidationByPrefixes(fn, {
    redis: options.redis,
    prefixes: [options.prefix],
    worker: options.worker,
  });
}

export function withCacheInvalidationByPrefixes<
  TArgs extends unknown[],
  TResult,
>(
  fn: (...args: TArgs) => Promise<TResult>,
  options: InvalidationByPrefixesOptions,
): (...args: TArgs) => Promise<TResult> {
  const { redis, prefixes, worker } = options;

  return async (...args: TArgs): Promise<TResult> => {
    const result = await fn(...args);

    if (worker) {
      try {
        await worker.enqueue(prefixes);
      } catch (err) {
        console.warn(
          `[protidhoni] Failed to enqueue invalidation for prefixes "${prefixes.join(', ')}":`,
          err,
        );
      }
      return result;
    }

    // Fire-and-forget: don't block the mutation response on cache invalidation
    invalidateCachePrefixes(redis, prefixes).catch((err) => {
      console.warn(
        `[protidhoni] Prefix invalidation failed for "${prefixes.join(', ')}":`,
        err,
      );
    });

    return result;
  };
}
