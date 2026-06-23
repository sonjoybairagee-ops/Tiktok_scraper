import { log } from 'apify';

/**
 * Dual-mode data extraction:
 * 1. Network interception (updated API patterns for 2025/2026)
 * 2. __NEXT_DATA__ / SIGI_STATE fallback from page HTML
 */

// Updated API patterns — TikTok now uses /api/2/ and /api/v2/ namespaces
const API_PATTERNS = {
    HASHTAG_VIDEOS: /\/api\/(?:2\/)?challenge\/item_list|\/api\/item_list\//,
    PROFILE_VIDEOS: /\/api\/(?:2\/)?post\/item_list|\/api\/user\/post\//,
    SEARCH_VIDEOS: /\/api\/(?:2\/)?search\/(?:item\/full|general\/full|video\/full)/,
    VIDEO_DETAIL: /\/api\/(?:2\/)?item\/detail/,
    COMMENTS: /\/api\/(?:2\/)?comment\/list/,
    USER_INFO: /\/api\/(?:2\/)?user\/detail/,
    // New endpoints observed in 2025-2026
    FEED: /\/api\/(?:recommend|mix)\/aweme\/v1/,
    SEARCH_NEW: /\/api\/search\/(?:suggest\/complete|item\/full_v2)/,
};

export async function interceptApiResponses(page, requestType) {
    const collectedVideoItems = [];
    const collectedComments = [];
    let profileData = null;
    let nextCursor = null;
    let hasMore = false;

    page.on('response', async (response) => {
        try {
            const url = response.url();
            const status = response.status();

            if (status !== 200) return;
            if (!url.includes('tiktok.com')) return;
            if (!isApiUrl(url)) return;

            const contentType = response.headers()['content-type'] || '';
            if (!contentType.includes('json') && !contentType.includes('javascript')) return;

            const body = await response.text();
            if (!body) return;

            // TikTok sometimes wraps JSON in JS: "window.__data = {...}"
            let jsonStr = body;
            if (!body.startsWith('{')) {
                const match = body.match(/\{.+\}/s);
                if (!match) return;
                jsonStr = match[0];
            }

            const json = JSON.parse(jsonStr);
            log.debug(`Intercepted API: ${url.split('?')[0]}`);

            processApiResponse(url, json, {
                collectedVideoItems,
                collectedComments,
                setProfileData: (d) => { profileData = d; },
                setCursor: (c, more) => { nextCursor = c; hasMore = more; },
            });

        } catch {
            // Ignore parse errors
        }
    });

    return {
        getResults: async () => {
            // If network interception got nothing, try __NEXT_DATA__ / SIGI_STATE
            if (collectedVideoItems.length === 0) {
                log.info('Network intercept got 0 items — trying page HTML extraction...');
                try {
                    const extracted = await extractFromPageHtml(page, requestType);
                    if (extracted.videoItems.length > 0) {
                        log.info(`HTML extraction found ${extracted.videoItems.length} items`);
                        collectedVideoItems.push(...extracted.videoItems);
                        if (extracted.profileData) profileData = extracted.profileData;
                    }
                } catch (e) {
                    log.warning(`HTML extraction failed: ${e.message}`);
                }
            }

            return {
                videoItems: collectedVideoItems,
                comments: collectedComments,
                profileData,
                nextCursor,
                hasMore,
            };
        },
    };
}

function isApiUrl(url) {
    return Object.values(API_PATTERNS).some((pattern) => pattern.test(url));
}

function processApiResponse(url, json, { collectedVideoItems, collectedComments, setProfileData, setCursor }) {
    if (API_PATTERNS.HASHTAG_VIDEOS.test(url)) {
        const items = json?.itemList || json?.item_list || json?.aweme_list || [];
        collectedVideoItems.push(...items);
        setCursor(json?.cursor, json?.hasMore ?? json?.has_more ?? false);
        log.info(`Hashtag API intercepted: ${items.length} videos`);
    }

    else if (API_PATTERNS.PROFILE_VIDEOS.test(url)) {
        const items = json?.itemList || json?.item_list || json?.aweme_list || [];
        collectedVideoItems.push(...items);
        setCursor(json?.cursor, json?.hasMore ?? json?.has_more ?? false);
        log.info(`Profile API intercepted: ${items.length} videos`);
    }

    else if (API_PATTERNS.SEARCH_VIDEOS.test(url) || API_PATTERNS.SEARCH_NEW.test(url)) {
        // Multiple known search response structures
        let items = [];
        if (json?.data) {
            items = json.data
                .filter((d) => d?.type === 1)
                .map((d) => d?.item || d?.aweme_info)
                .filter(Boolean);
        } else if (json?.aweme_list) {
            items = json.aweme_list;
        }
        collectedVideoItems.push(...items);
        setCursor(json?.cursor, json?.has_more ?? json?.hasMore ?? false);
        log.info(`Search API intercepted: ${items.length} videos`);
    }

    else if (API_PATTERNS.VIDEO_DETAIL.test(url)) {
        const item = json?.itemInfo?.itemStruct || json?.item || json?.aweme_detail;
        if (item) {
            collectedVideoItems.push(item);
            log.info(`Video detail API intercepted: ${item.id || item.aweme_id}`);
        }
    }

    else if (API_PATTERNS.COMMENTS.test(url)) {
        const comments = json?.comments || json?.comment_list || [];
        collectedComments.push(...comments);
        log.info(`Comments API intercepted: ${comments.length} comments`);
    }

    else if (API_PATTERNS.USER_INFO.test(url)) {
        const user = json?.userInfo?.user || json?.user?.user || json?.user;
        const stats = json?.userInfo?.stats || json?.user?.stats || json?.stats;
        if (user) {
            setProfileData(buildProfileData(user, stats));
            log.info(`User API intercepted: @${user.uniqueId || user.unique_id}`);
        }
    }

    else if (API_PATTERNS.FEED.test(url)) {
        const items = json?.aweme_list || json?.itemList || [];
        if (items.length > 0) {
            collectedVideoItems.push(...items);
            setCursor(json?.cursor, json?.has_more ?? false);
            log.info(`Feed API intercepted: ${items.length} videos`);
        }
    }
}

/**
 * Fallback: extract video data embedded in the page HTML.
 * TikTok embeds data in <script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">
 * and window['SIGI_STATE'] — both contain full video/profile data.
 */
async function extractFromPageHtml(page, requestType) {
    return await page.evaluate((type) => {
        const results = { videoItems: [], profileData: null };

        // Method 1: __UNIVERSAL_DATA_FOR_REHYDRATION__ (newer TikTok)
        try {
            const el = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (el) {
                const data = JSON.parse(el.textContent);
                const webapp = data?.['__DEFAULT_SCOPE__']?.['webapp.video-detail']
                    || data?.['__DEFAULT_SCOPE__']?.['webapp.user-detail']
                    || data?.['__DEFAULT_SCOPE__']?.['webapp.hashtag-detail'];

                if (webapp) {
                    // Video detail page
                    const videoInfo = webapp?.itemInfo?.itemStruct;
                    if (videoInfo) results.videoItems.push(videoInfo);

                    // User/profile page
                    const userInfo = webapp?.userInfo;
                    if (userInfo?.user) {
                        results.profileData = {
                            userId: userInfo.user.id,
                            uniqueId: userInfo.user.uniqueId,
                            nickname: userInfo.user.nickname,
                            avatarUrl: userInfo.user.avatarMedium || userInfo.user.avatarThumb,
                            signature: userInfo.user.signature || '',
                            verified: userInfo.user.verified || false,
                            region: userInfo.user.region || null,
                            stats: {
                                followerCount: userInfo.stats?.followerCount ?? null,
                                followingCount: userInfo.stats?.followingCount ?? null,
                                heartCount: userInfo.stats?.heartCount ?? null,
                                videoCount: userInfo.stats?.videoCount ?? null,
                            },
                            scrapedAt: new Date().toISOString(),
                        };
                    }
                }
            }
        } catch {}

        // Method 2: SIGI_STATE (older/fallback TikTok pages)
        try {
            const sigiEl = document.querySelector('#SIGI_STATE');
            if (sigiEl && results.videoItems.length === 0) {
                const sigi = JSON.parse(sigiEl.textContent);

                // ItemModule contains video items keyed by video ID
                const itemModule = sigi?.ItemModule;
                if (itemModule) {
                    const items = Object.values(itemModule);
                    results.videoItems.push(...items);
                }

                // UserModule for profile data
                const userModule = sigi?.UserModule?.users;
                if (userModule) {
                    const users = Object.values(userModule);
                    if (users.length > 0) {
                        const u = users[0];
                        const stats = sigi?.UserModule?.stats?.[u.uniqueId];
                        results.profileData = {
                            userId: u.id,
                            uniqueId: u.uniqueId,
                            nickname: u.nickname,
                            avatarUrl: u.avatarMedium || u.avatarThumb,
                            signature: u.signature || '',
                            verified: u.verified || false,
                            region: u.region || null,
                            stats: {
                                followerCount: stats?.followerCount ?? null,
                                followingCount: stats?.followingCount ?? null,
                                heartCount: stats?.heartCount ?? null,
                                videoCount: stats?.videoCount ?? null,
                            },
                            scrapedAt: new Date().toISOString(),
                        };
                    }
                }
            }
        } catch {}

        return results;
    }, requestType);
}

function buildProfileData(user, stats) {
    return {
        userId: user.id || user.uid,
        uniqueId: user.uniqueId || user.unique_id,
        nickname: user.nickname,
        avatarUrl: user.avatarMedium || user.avatarThumb || user.avatar_medium?.url_list?.[0],
        signature: user.signature || user.bio_description || '',
        verified: user.verified || false,
        region: user.region || null,
        stats: {
            followerCount: stats?.followerCount ?? stats?.follower_count ?? null,
            followingCount: stats?.followingCount ?? stats?.following_count ?? null,
            heartCount: stats?.heartCount ?? stats?.total_favorited ?? null,
            videoCount: stats?.videoCount ?? stats?.aweme_count ?? null,
        },
        scrapedAt: new Date().toISOString(),
    };
}
