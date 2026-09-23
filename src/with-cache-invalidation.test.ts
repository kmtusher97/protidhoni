import {
  withCacheInvalidation,
  withCacheInvalidationByPrefix,
  withCacheInvalidationByPrefixes,
} from './with-cache-invalidation';
import type { RedisLike } from './types';

class MockRedis implements RedisLike {
  store = new Map<string, string>();
  deletedKeys: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setex(key: string, _seconds: number, value: string): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      this.deletedKeys.push(key);
      if (this.store.delete(key)) count++;
    }
    return count;
  }

  scanStream(): never {
    throw new Error('scanStream not implemented in MockRedis');
  }
}

const identity = async (x: string) => x;

describe('withCacheInvalidation', () => {
  it('calls the wrapped function and returns its result', async () => {
    const redis = new MockRedis();
    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
    });

    expect(await wrapped('hello')).toBe('hello');
  });

  it('deletes the cache key after the mutation', async () => {
    const redis = new MockRedis();
    await redis.setex('p:foo', 60, 'cached');

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
    });

    await wrapped('foo');

    expect(redis.store.has('p:foo')).toBe(false);
    expect(redis.deletedKeys).toContain('p:foo');
  });

  it('keyBuilder returning string[] uses the strings as full keys — no prefix applied', async () => {
    const redis = new MockRedis();
    await redis.setex('ns-a:user1:content1', 60, 'cached');
    await redis.setex('ns-b:user1', 60, 'cached');

    const wrapped = withCacheInvalidation(
      async (userId: string, contentId: string) => `${userId}:${contentId}`,
      {
        redis,
        prefix: 'ns-a',
        keyBuilder: (userId, contentId) => [
          `ns-a:${userId}:${contentId}`,
          `ns-b:${userId}`,
        ],
      },
    );

    await wrapped('user1', 'content1');

    expect(redis.store.has('ns-a:user1:content1')).toBe(false);
    expect(redis.store.has('ns-b:user1')).toBe(false);
    expect(redis.deletedKeys).toEqual(['ns-a:user1:content1', 'ns-b:user1']);
  });

  it('keyBuilder returning a single string behaves as before', async () => {
    const redis = new MockRedis();
    await redis.setex('ns:key1', 60, 'val');

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'ns',
      keyBuilder: (x) => x,
    });

    await wrapped('key1');

    expect(redis.deletedKeys).toEqual(['ns:key1']);
  });

  it('does not throw when redis.del rejects', async () => {
    const redis = new MockRedis();
    jest.spyOn(redis, 'del').mockRejectedValue(new Error('Redis down'));

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
    });

    await expect(wrapped('anything')).resolves.toBe('anything');
  });

  it('still returns the mutation result when del fails with multiple keys', async () => {
    const redis = new MockRedis();
    jest.spyOn(redis, 'del').mockRejectedValue(new Error('Redis down'));

    const wrapped = withCacheInvalidation(
      async (x: string) => x.toUpperCase(),
      {
        redis,
        prefix: 'p',
        keyBuilder: (x) => [`p:${x}`, `q:${x}`],
      },
    );

    await expect(wrapped('hello')).resolves.toBe('HELLO');
  });

  it('enqueues via worker instead of deleting inline when worker config is given', async () => {
    const redis = new MockRedis();
    await redis.setex('p:foo', 60, 'cached');
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
      worker: { enqueue },
    });

    await wrapped('foo');

    expect(enqueue).toHaveBeenCalledWith(['p:foo']);
    expect(redis.deletedKeys).toEqual([]);
    expect(redis.store.has('p:foo')).toBe(true);
  });

  it('does not call refetch when worker config is given', async () => {
    const redis = new MockRedis();
    const refetch = jest.fn().mockResolvedValue(undefined);
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
      refetch,
      worker: { enqueue },
    });

    await wrapped('foo');

    expect(refetch).not.toHaveBeenCalled();
  });

  it('does not throw when worker.enqueue rejects', async () => {
    const redis = new MockRedis();
    const enqueue = jest.fn().mockRejectedValue(new Error('queue down'));

    const wrapped = withCacheInvalidation(identity, {
      redis,
      prefix: 'p',
      keyBuilder: (x) => x,
      worker: { enqueue },
    });

    await expect(wrapped('foo')).resolves.toBe('foo');
  });
});

describe('withCacheInvalidationByPrefixes', () => {
  it('enqueues the prefixes via worker instead of scanning inline', async () => {
    const redis = new MockRedis();
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const wrapped = withCacheInvalidationByPrefixes(identity, {
      redis,
      prefixes: ['a', 'b'],
      worker: { enqueue },
    });

    await expect(wrapped('foo')).resolves.toBe('foo');
    expect(enqueue).toHaveBeenCalledWith(['a', 'b']);
  });

  it('does not throw when worker.enqueue rejects', async () => {
    const redis = new MockRedis();
    const enqueue = jest.fn().mockRejectedValue(new Error('queue down'));

    const wrapped = withCacheInvalidationByPrefixes(identity, {
      redis,
      prefixes: ['a'],
      worker: { enqueue },
    });

    await expect(wrapped('foo')).resolves.toBe('foo');
  });
});

describe('withCacheInvalidationByPrefix', () => {
  it('enqueues a single-element prefixes array via worker', async () => {
    const redis = new MockRedis();
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const wrapped = withCacheInvalidationByPrefix(identity, {
      redis,
      prefix: 'a',
      worker: { enqueue },
    });

    await expect(wrapped('foo')).resolves.toBe('foo');
    expect(enqueue).toHaveBeenCalledWith(['a']);
  });
});
