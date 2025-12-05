let Redis;
try {
    Redis = require('ioredis');
} catch (err) {
    // Dependency might not be installed in some environments
}

const CACHE_URL = process.env.CACHE_REDIS_URL;
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false' && !!CACHE_URL && !!Redis;
const DEFAULT_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '1800', 10);

let client = null;
let permanentlyDisabled = false;

function getClient() {
    if (!CACHE_ENABLED || permanentlyDisabled) {
        return null;
    }
    if (!client) {
        try {
            client = new Redis(CACHE_URL, {
                lazyConnect: true,
                maxRetriesPerRequest: 1,
            });
            client.on('error', (err) => {
                console.warn('[cache] Redis error:', err?.message || err);
            });
        } catch (err) {
            console.warn('[cache] Failed to initialize Redis:', err?.message || err);
            permanentlyDisabled = true;
            return null;
        }
    }
    return client;
}

async function cacheGet(key) {
    const redis = getClient();
    if (!redis) {
        return null;
    }
    try {
        const value = await redis.get(key);
        return value ? JSON.parse(value) : null;
    } catch (err) {
        console.warn('[cache] Failed to read key', key, err?.message || err);
        return null;
    }
}

async function cacheSet(key, value, ttlSeconds = DEFAULT_TTL) {
    const redis = getClient();
    if (!redis) {
        return;
    }
    try {
        await redis.set(key, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
    } catch (err) {
        console.warn('[cache] Failed to write key', key, err?.message || err);
    }
}

module.exports = { cacheGet, cacheSet, CACHE_ENABLED };
