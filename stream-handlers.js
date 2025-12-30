const { Agent } = require('undici');
const { cacheGet, cacheSet, CACHE_ENABLED } = require('./cache');
const { schedule, deduped } = require('./request-manager');
const { increment } = require('./metrics');

const ACCEPTED_FILE_TYPES = ['avi', 'mp4', 'mkv', 'wmv', 'mov', 'm4v'];
const ACCEPTED_SUBTITLES = ['srt', 'vtt', 'ass'];
const MAX_STREAMS = 5;
const MAX_STREAMS_SERIES = 15;
const SOURCE_LABEL = process.env.STREAM_SOURCE_LABEL || 'Archive.org';

const dispatcher = new Agent({
    keepAliveTimeout: 10_000,
    keepAliveMaxTimeout: 60_000,
    connectTimeout: 15_000,
});

const DEFAULT_FETCH_TIMEOUT_MS = Math.max(1_000, parseInt(process.env.UPSTREAM_TIMEOUT_MS || '10000', 10));
const ARCHIVE_SEARCH_ENDPOINT = process.env.ARCHIVE_SEARCH_ENDPOINT || 'https://archive.org/advancedsearch.php';
const ARCHIVE_SEARCH_FIELDS = ['identifier', 'title', 'description'];
const DEFAULT_SEARCH_SORT = ['week desc'];

const DEFAULT_STREAM_TTL = Math.max(60, parseInt(process.env.CACHE_STREAM_TTL || '1800', 10));
const NEGATIVE_CACHE_TTL = Math.max(30, parseInt(process.env.CACHE_NEGATIVE_TTL || '120', 10));
const STALE_AFTER_MS = Math.max(0, parseInt(process.env.CACHE_STALE_AFTER_SECONDS || '900', 10) * 1000);
const CACHE_TTL_JITTER = Math.max(0, parseFloat(process.env.CACHE_TTL_JITTER || '0.2'));
const ARCHIVE_FILES_TTL = Math.max(300, parseInt(process.env.CACHE_ARCHIVE_FILES_TTL || '21600', 10));
const ARCHIVE_FILES_EMPTY_TTL = Math.max(60, parseInt(process.env.CACHE_ARCHIVE_FILES_EMPTY_TTL || '600', 10));

const refreshingKeys = new Set();

const sizeToString = (bytes) => bytes >= 1073741824
    ? `${(bytes / 1073741824).toFixed(1)}GB`
    : `${(bytes / 1048576).toFixed(0)}MB`;

const slugifyToken = (value = '') => value
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '');

const buildReleaseSlug = ({
    title,
    year,
    season,
    episode,
    quality,
    resolution,
    codec,
    extension,
}) => {
    const tokens = [];
    const titleToken = slugifyToken(title);
    if (titleToken) tokens.push(titleToken);
    if (year) tokens.push(String(year));
    if (season && episode) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        tokens.push(`S${s}E${e}`);
    }
    if (quality) tokens.push(slugifyToken(quality).toUpperCase());
    if (resolution) tokens.push(`${resolution}p`);
    const codecToken = codec || extension;
    if (codecToken) tokens.push(slugifyToken(codecToken).toUpperCase());
    const slugBase = (tokens.filter(Boolean).join('.')) || slugifyToken(title || 'ArchiveOrg');
    const ext = (extension || '').replace(/^\./, '');
    return ext ? `${slugBase}.${ext}` : slugBase;
};

function formatStreamName(sourceTitle, qualityTag, fileMeta) {
    const detailParts = [];
    if (qualityTag) detailParts.push(qualityTag.trim().toUpperCase());
    if (fileMeta?.height) detailParts.push(`${fileMeta.height}p`);
    const fileFormat = (fileMeta?.format || fileMeta?.source || fileMeta?.name?.split('.').pop() || '').toUpperCase();
    if (fileFormat) detailParts.push(fileFormat);
    const suffix = detailParts.length ? ` • ${detailParts.join(' · ')}` : '';
    let emoji = '📼';
    if ((fileMeta?.height || 0) >= 2160) emoji = '🌌';
    else if ((fileMeta?.height || 0) >= 1080) emoji = '🎞️';
    else if ((fileMeta?.height || 0) >= 720) emoji = '📽️';
    return `${emoji} ${SOURCE_LABEL} • ${sourceTitle}${suffix}`;
}

async function limitedFetchJson(url, options = {}) {
    const { timeoutMs = DEFAULT_FETCH_TIMEOUT_MS, ...fetchOptions } = options;
    const controller = new AbortController();
    const timeout = Math.max(1, timeoutMs);
    const timeoutHandle = setTimeout(() => controller.abort(), timeout);
    timeoutHandle.unref?.();
    try {
        const res = await schedule(() => fetch(url, { dispatcher, ...fetchOptions, signal: controller.signal }));
        if (!res.ok) {
            increment('upstreamErrors');
            let bodySnippet = '';
            try {
                const text = await res.text();
                bodySnippet = text ? ` body: ${text.slice(0, 256)}` : '';
            } catch (err) {
                bodySnippet = ` body: <unavailable: ${err?.message || err}>`;
            }
            console.warn('[fetch]', res.status, res.statusText, url, bodySnippet);
            return null;
        }
        return res.json();
    } catch (err) {
        increment('upstreamErrors');
        const label = err?.name === 'AbortError' ? '[fetch timeout]' : '[fetch]';
        console.warn(label, url, err?.message || err);
        return null;
    } finally {
        clearTimeout(timeoutHandle);
    }
}

async function getCinemetaMeta(type, id) {
    return deduped(`cinemeta:${type}:${id}`, async () => {
        const json = await limitedFetchJson(`https://v3-cinemeta.strem.io/meta/${type}/${id}.json`);
        return json?.meta || null;
    });
}

async function searchArchive(queryKey, { query, rows, sort } = {}) {
    return deduped(`archive:search:${queryKey}`, async () => {
        const params = new URLSearchParams();
        const rowCount = Math.max(1, rows || MAX_STREAMS);
        params.set('q', query);
        params.set('rows', String(rowCount));
        params.set('page', '1');
        params.set('output', 'json');
        ARCHIVE_SEARCH_FIELDS.forEach((field) => params.append('fl[]', field));
        (sort && sort.length ? sort : DEFAULT_SEARCH_SORT).forEach((entry) => params.append('sort[]', entry));
        const json = await limitedFetchJson(`${ARCHIVE_SEARCH_ENDPOINT}?${params.toString()}`);
        const docs = json?.response?.docs;
        return Array.isArray(docs) ? docs : [];
    });
}

async function getArchiveFiles(identifier) {
    const cacheKey = `archive:files:${identifier}`;
    if (CACHE_ENABLED) {
        const cached = await cacheGet(cacheKey);
        if (cached) {
            return cached;
        }
    }
    return deduped(`archive:files:${identifier}`, async () => {
        const json = await limitedFetchJson(`https://archive.org/metadata/${identifier}/files`);
        const files = json?.result || [];
        if (CACHE_ENABLED) {
            await cacheSet(cacheKey, files, files.length ? ARCHIVE_FILES_TTL : ARCHIVE_FILES_EMPTY_TTL);
        }
        return files;
    });
}

function ttlForPayload(payload) {
    return (payload?.streams?.length || 0) > 0 ? DEFAULT_STREAM_TTL : NEGATIVE_CACHE_TTL;
}

function jitter(ttl) {
    if (!CACHE_ENABLED || CACHE_TTL_JITTER <= 0) return ttl;
    const delta = ttl * CACHE_TTL_JITTER;
    const min = ttl - delta / 2;
    return Math.max(1, Math.round(min + Math.random() * delta));
}

async function getCachedResponse(cacheKey) {
    if (!CACHE_ENABLED) return null;
    const entry = await cacheGet(cacheKey);
    if (!entry) return null;
    if (entry.data) {
        return entry;
    }
    return { data: entry, cachedAt: entry.cachedAt || 0 };
}

async function storeResponse(cacheKey, payload, ttlOverride) {
    if (!CACHE_ENABLED) return;
    const ttl = jitter(ttlOverride || ttlForPayload(payload));
    await cacheSet(cacheKey, { data: payload, cachedAt: Date.now() }, ttl);
}

function maybeRevalidate(cacheKey, cachedAt, builder) {
    if (!CACHE_ENABLED || !cachedAt || STALE_AFTER_MS === 0) return;
    if (Date.now() - cachedAt < STALE_AFTER_MS) return;
    if (refreshingKeys.has(cacheKey)) return;
    refreshingKeys.add(cacheKey);
    setImmediate(async () => {
        try {
            const fresh = await builder();
            await storeResponse(cacheKey, fresh);
        } catch (err) {
            console.warn('[cache] background refresh failed for', cacheKey, err?.message || err);
        } finally {
            refreshingKeys.delete(cacheKey);
        }
    });
}

async function buildMovieStreams(imdbId, log = { test: false, query: false }) {
    const film = await getCinemetaMeta('movie', imdbId);
    if (!film) {
        return { streams: [] };
    }
    const title = film.name.toLowerCase().replace(/^the /i, '');
    const runtimeMinutes = parseInt(film?.runtime, 10) || 0;
    const runtimeSeconds = runtimeMinutes * 60;
    if (!runtimeSeconds) {
        console.warn("Error: can't get runtime, set to zero.");
    }
    const directorSurname = (film.director?.[0] || '').split(' ').slice(-1)[0];
    const year = parseInt(film.year, 10) || 0;
    const queryParts = [
        `(${directorSurname} OR ${year} OR ${year - 1} OR ${year + 1})`,
        `title:(${title})`,
        '-title:trailer',
        'mediatype:movies',
        'item_size:["300000000" TO "100000000000"]',
    ];
    const archiveQuery = queryParts.join(' AND ');
    if (log.query) console.log(archiveQuery);
    const results = await searchArchive(`movie:${imdbId}`, {
        query: archiveQuery,
        rows: MAX_STREAMS,
        sort: ['week desc'],
    });
    const streams = [];
    for (const res of results) {
        const identifier = res.identifier;
        if (!identifier) continue;
        const docTitle = res.title || '';
        const docDescription = Array.isArray(res.description) ? res.description.join(' ') : (res.description || '');
        const files = await getArchiveFiles(identifier);
        const subtitles = files
            .filter((f) => ACCEPTED_SUBTITLES.includes(f.name.slice(-3).toLowerCase()))
            .map((f) => ({ id: f.name, url: `https://archive.org/download/${identifier}/${f.name}`, lang: 'en' }));
        const videoFiles = files.filter((f) => ACCEPTED_FILE_TYPES.includes(f.name.slice(-3).toLowerCase()) && f.length > runtimeSeconds * 0.7);
        if (videoFiles.length === 0) {
            continue;
        }
        const quality = ((docTitle || '') + videoFiles[0].name + docDescription)
            .match(/(?:dvd|blu-?ray|bd|hd|web|nd-?rip)-?(?:rip|dl)?|remux/i)?.[0] || '';
        streams.push(
            ...videoFiles.map((f) => {
                const extension = (f.name.split('.').pop() || '').toLowerCase();
                const isWebReady = extension === 'mp4';
                const sizeBytes = parseInt(f.size, 10) || 0;
                const releaseSlug = buildReleaseSlug({
                    title: docTitle || film.name,
                    year,
                    quality,
                    resolution: f.height || undefined,
                    codec: f.format || f.source || undefined,
                    extension,
                });
                const sourceInfo = f.source ? ` (${f.source})` : '';
                const detailLines = [
                    docTitle,
                    f.name !== releaseSlug ? `Source file: ${f.name}` : '',
                    `🎬 ${extension || 'file'}${sourceInfo}`,
                    `🕥 ${(f.length / 60).toFixed(0)} min   💾 ${sizeToString(sizeBytes)}`,
                ].filter(Boolean);
                return {
                    url: `https://archive.org/download/${identifier}/${f.name}`,
                    name: formatStreamName(docTitle || film.name, quality, f),
                    description: [releaseSlug, ...detailLines].join('\n'),
                    subtitles,
                    behaviorHints: {
                        notWebReady: !isWebReady,
                        videoSize: sizeBytes,
                        filename: releaseSlug,
                    },
                };
            })
        );
    }
    const response = { streams };
    if (log.test) {
        const identifier = streams?.[0]?.url?.split('/')?.[4] || '';
        console.log(`{"id": "${imdbId}", "name": "${film.name}", "identifier": "${identifier}", "type": "movie"}`);
    }
    return response;
}

async function buildSeriesStreams(id, log = { test: false, query: false }) {
    const [imdbId, season, ep] = id.split(':');
    const series = await getCinemetaMeta('series', imdbId);
    if (!series) {
        return { streams: [] };
    }
    const seasonNumber = parseInt(season, 10) || undefined;
    const episodeNumber = parseInt(ep, 10) || undefined;
    const sMatchName = series.name.toLowerCase().replace(/\W/g, '*');
    const episode = series.videos?.find((e) => e.season == season && e.episode == ep);
    if (!episode) {
        return { streams: [] };
    }
    const epName = (episode.name || episode.title)
        .replace(/^the /i, '')
        .replace(/\W*part\W*[0-9IVX]+\W*/i, ' ')
        .replace(/\(.*\)/g, '')
        .trim();
    const queryParts = [
        `title:("${sMatchName}" OR *${sMatchName}*)`,
        '-title:(trailer OR trailers OR promo OR promos OR review OR reviews OR interview OR interviews)',
        'mediatype:movies',
        '(series OR collection:(television OR unsorted_television OR opensource_movies))',
    ];
    if ((series.genres || []).includes('Soap')) {
        const mmyyyy = (episode.name || episode.title).match(/(january|february|march|april|may|june|july|august|september|october|november|december).*([12][90]\d{2})/i);
        queryParts[0] = mmyyyy ? `title:(${series.name.toLowerCase()} ${mmyyyy[1]} ${mmyyyy[2]})` : queryParts[0];
        queryParts.pop();
    }
    const archiveQuery = queryParts.join(' AND ');
    if (log.query) console.log(archiveQuery);
    const results = await searchArchive(`series:${imdbId}:${season}:${ep}`, {
        query: archiveQuery,
        rows: MAX_STREAMS_SERIES,
    });
    const epNameRegex = new RegExp('.*' + epName.replace(/[^a-z0-9]/gi, '.*') + '.*', 'i');
    const streams = [];
    for (const res of results) {
        const identifier = res.identifier;
        if (!identifier) continue;
        const docTitle = res.title || '';
        const docDescription = Array.isArray(res.description) ? res.description.join(' ') : (res.description || '');
        const wrongSeason = new RegExp(`(?:(?:^|[^a-z])s|season)\\D?0*(?!${season}(?:\\D|$))\\d+`, 'i');
        if ((docTitle + identifier).match(wrongSeason)) continue;
        let regex;
        if ((docTitle + identifier).match(/season|[^a-z0-9]s[^a-z]?\\d|^s[^a-z]?/i)) {
            regex = new RegExp(`(?:(?:^|[^a-z])ep?|episode)\\D?0*${ep}(?:\\D|$)`, 'i');
        } else {
            regex = new RegExp(`s(?:eason)?\\D?0*${season}\\D*(?:ep?|episode)\\D?0*${ep}(?:\\D|$)`, 'i');
        }
        const files = await getArchiveFiles(identifier);
        const subtitles = files
            .filter((f) => ACCEPTED_SUBTITLES.includes(f.name.slice(-3).toLowerCase()) && (f.name.match(regex) || f.name.match(epNameRegex)))
            .map((f) => ({ id: f.name, url: `https://archive.org/download/${identifier}/${f.name}`, lang: 'en' }));
        const videoFiles = files.filter((f) =>
            (f.name.match(regex) || f.name.match(epNameRegex))
            && ACCEPTED_FILE_TYPES.includes(f.name.slice(-3).toLowerCase())
            && f.name.slice(-7, -3) !== '.ia.'
        );
        if (videoFiles.length === 0) {
            continue;
        }
        const quality = ((docTitle || '') + videoFiles[0].name + docDescription)
            .match(/(?:dvd|blu-?ray|bd|hd|web|nd-?rip)-?(?:rip|dl)?|remux/i)?.[0] || '';
        streams.push(
            ...videoFiles.map((f) => {
                const extension = (f.name.split('.').pop() || '').toLowerCase();
                const isWebReady = extension === 'mp4';
                const sizeBytes = parseInt(f.size, 10) || 0;
                const releaseSlug = buildReleaseSlug({
                    title: docTitle || series.name,
                    year: series.year,
                    season: seasonNumber,
                    episode: episodeNumber,
                    quality,
                    resolution: f.height || undefined,
                    codec: f.format || f.source || undefined,
                    extension,
                });
                const sourceInfo = f.source ? ` (${f.source})` : '';
                const detailLines = [
                    docTitle,
                    f.name !== releaseSlug ? `Source file: ${f.name}` : '',
                    `🎬 ${extension || 'file'}${sourceInfo}`,
                    `🕥 ${(f.length / 60).toFixed(0)} min   💾 ${sizeToString(sizeBytes)}`,
                ].filter(Boolean);
                return {
                    url: `https://archive.org/download/${identifier}/${f.name}`,
                    name: formatStreamName(docTitle || series.name, quality, f),
                    description: [releaseSlug, ...detailLines].join('\n'),
                    subtitles,
                    behaviorHints: {
                        notWebReady: !isWebReady,
                        videoSize: sizeBytes,
                        filename: releaseSlug,
                    },
                };
            })
        );
    }
    const response = { streams };
    if (log.test) {
        const identifier = streams?.[0]?.url?.split('/')?.[4] || '';
        console.log(`{"id": "${id}", "name": "${series.name}", "identifier": "${identifier}", "type": "series"}`);
    }
    return response;
}

async function fetchMovieStreams(id, log = { test: false, query: false }) {
    increment('requests');
    const cacheKey = `streams:movie:${id}`;
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
        increment('cacheHits');
        maybeRevalidate(cacheKey, cached.cachedAt, () => buildMovieStreams(id, { test: false, query: false }));
        return cached.data;
    }
    increment('cacheMisses');
    const response = await buildMovieStreams(id, log);
    await storeResponse(cacheKey, response);
    return response;
}

async function fetchSeriesStreams(id, log = { test: false, query: false }) {
    increment('requests');
    const cacheKey = `streams:series:${id}`;
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
        increment('cacheHits');
        maybeRevalidate(cacheKey, cached.cachedAt, () => buildSeriesStreams(id, { test: false, query: false }));
        return cached.data;
    }
    increment('cacheMisses');
    const response = await buildSeriesStreams(id, log);
    await storeResponse(cacheKey, response);
    return response;
}

module.exports = { fetchMovieStreams, fetchSeriesStreams };