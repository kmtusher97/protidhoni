# protidhoni

প্রতিধ্বনি (*protidhoni*) — "echo." Redis-backed caching and invalidation
higher-order functions for Node.js: wrap an async function with read-through
caching, then invalidate it by exact key, by prefix, or defer invalidation to
a worker queue.

## Install

```sh
npm install protidhoni ioredis
```

`ioredis` is a peer dependency — bring your own client.

## Usage

### `withCache`

Wraps an async function with read-through caching.

```ts
import Redis from 'ioredis';
import { withCache } from 'protidhoni';

const redis = new Redis();

const getUser = withCache(
  async (id: string) => db.users.findById(id),
  {
    redis,
    prefix: 'user',
    ttl: 60, // seconds
    keyBuilder: (id) => id,
  },
);

await getUser('123'); // MISS: runs the function, caches the result
await getUser('123'); // HIT: served from Redis
```

### `withCacheInvalidation`

Wraps a write to invalidate one or more cache keys after it runs, with an
optional re-fetch to re-warm the cache immediately.

```ts
import { withCacheInvalidation } from 'protidhoni';

const updateUser = withCacheInvalidation(
  async (id: string, patch: Partial<User>) => db.users.update(id, patch),
  {
    redis,
    prefix: 'user',
    keyBuilder: (id) => id,
    refetch: (id) => getUser(id),
  },
);
```

### `withCacheInvalidationByPrefix(es)`

Invalidates every key under one or more prefixes (via `SCAN`, not `KEYS`, so
it's safe on a live keyspace).

```ts
import { withCacheInvalidationByPrefix } from 'protidhoni';

const deleteAllUsers = withCacheInvalidationByPrefix(
  async () => db.users.deleteAll(),
  { redis, prefix: 'user' },
);
```

### Deferred invalidation via a worker

Pass `worker.enqueue` to hand the resolved keys/prefixes off to a queue
instead of invalidating inline — useful when invalidation is expensive or you
want to batch/debounce it. `protidhoni` stays queue-library-agnostic; you
supply the `enqueue` function.

```ts
const updateUser = withCacheInvalidation(fn, {
  redis,
  prefix: 'user',
  keyBuilder: (id) => id,
  worker: {
    enqueue: async (keys) => myQueue.add('invalidate', { keys }),
  },
});
```

### Standalone helpers

```ts
import { invalidateCacheKeys, invalidateCachePrefixes } from 'protidhoni';

await invalidateCacheKeys(redis, ['user:123', 'user:456']);
await invalidateCachePrefixes(redis, ['user', 'session']);
```

## API

| Export | Description |
| --- | --- |
| `withCache(fn, options)` | Read-through cache wrapper. `options: { redis, prefix, ttl, keyBuilder }` |
| `withCacheInvalidation(fn, options)` | Invalidates on write. `options: { redis, prefix, keyBuilder, refetch?, worker? }` |
| `withCacheInvalidationByPrefix(fn, options)` | Invalidates one prefix on write. `options: { redis, prefix, worker? }` |
| `withCacheInvalidationByPrefixes(fn, options)` | Invalidates multiple prefixes on write. `options: { redis, prefixes, worker? }` |
| `invalidateCacheKeys(redis, keys)` | Delete an explicit list of keys. |
| `invalidateCachePrefixes(redis, prefixes)` | Scan and delete every key under each prefix. |

Full types are exported: `CacheOptions`, `InvalidationOptions`,
`InvalidationByPrefixOptions`, `InvalidationByPrefixesOptions`,
`WorkerInvalidationConfig`, `RedisLike`.

`RedisLike` is a minimal interface (`get`, `setex`, `del`, `scanStream`), not
a hard dependency on `ioredis`'s concrete type — any client that satisfies it
works.

## Behavior notes

- Redis read/write errors are caught and logged (`console.warn`), never
  thrown — a cache outage degrades to "always miss," not a hard failure.
- Prefix invalidation uses `SCAN` (via `scanStream`), not `KEYS`, so it won't
  block Redis on a large keyspace.
- Prefix-based invalidation runs fire-and-forget after the wrapped write
  resolves — it does not block the write's response.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run test
```

CI (`.github/workflows/ci.yml`) runs typecheck, lint, build, and tests on
every push and PR to `main`.

## Releasing

Publishing to npm is handled by `.github/workflows/release.yml`, triggered by
pushing a `v*.*.*` tag:

```sh
npm version patch   # or minor / major — updates package.json and creates a git tag
git push --follow-tags
```

The workflow builds, tests, verifies the pushed tag matches
`package.json`'s `version`, then runs `npm publish` with
[provenance](https://docs.npmjs.com/generating-provenance-statements). It
authenticates using the `NPM_TOKEN` repository secret (an npm
[automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
with publish access) — set it once under
Settings → Secrets and variables → Actions.

## License

MIT
