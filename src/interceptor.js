/**
 * TikTok Network Interceptor & HTML Fallback Extractor
 * Dual-mode data extraction with updated API patterns for 2026.
 */

import { log } from 'apify';

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

            // ✅ IMPROVEMENT: Safe JSON parsing
            let json;
            try {
                json = JSON.parse(jsonStr);
            } catch (e) {
                log.debug(`Failed to parse JSON from: ${url.split('?')[0]}`);
                return;
            }

            log.debug(`Intercepted API: ${url.split('?')[0]}`);

            processApiResponse(url, json, {
                collectedVideoItems,
                collectedComments,
                setProfileData: (d) => { profileData = d; },
                setCursor: (c, more) => { nextCursor = c; hasMore = more; },
            });

        } catch (e) {
            // Silently ignore parse errors
            log.debug(`Response intercept error: ${e.message}`);
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
                videoItems: [...new Set(collectedVideoItems.map(JSON.stringify))].map(JSON.parse), // Dedupe
                comments: [...new Set(collectedComments.map(JSON.stringify))].map(JSON.parse),
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
        } catch (e) {
            // Silently ignore HTML parse errors
        }

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
        } catch (e) {
            // Silently ignore HTML parse errors
        }

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

/**
 * Maps a raw TikTok API video item to a clean, consistent output format.
 * The raw item comes directly from TikTok's internal API — same structure
 * across hashtag, profile, search, and video detail endpoints.
 */
export function processVideoItems(item, { sourceLabel, scrapeMusic = true }) {
    if (!item || !item.id) return null;

    const author = item.author || {};
    const authorStats = item.authorStats || author.stats || {};
    const stats = item.stats || {};
    const video = item.video || {};
    const music = item.music || {};
    const challenges = item.challenges || []; // hashtags

    return {
        // ── Core info ──
        videoId: item.id,
        videoUrl: `https://www.tiktok.com/@${author.uniqueId}/video/${item.id}`,
        description: item.desc || '',
        hashtags: challenges.map((c) => c.title).filter(Boolean),
        createTime: item.createTime
            ? new Date(item.createTime * 1000).toISOString()
            : null,
        shareUrl: item.video?.shareUrl || null,
        scrapedAt: new Date().toISOString(),
        sourceLabel,

        // ── Author / Profile ──
        author: {
            id: author.id || null,
            uniqueId: author.uniqueId || null,
            nickname: author.nickname || null,
            avatarUrl: author.avatarMedium || author.avatarThumb || null,
            verified: author.verified || false,
            signature: author.signature || '',
            region: author.region || null,
            // Stats (available when scraping profiles, sometimes in video list too)
            followerCount: authorStats.followerCount ?? null,
            followingCount: authorStats.followingCount ?? null,
            heartCount: authorStats.heartCount ?? null,
            videoCount: authorStats.videoCount ?? null,
            profileUrl: author.uniqueId
                ? `https://www.tiktok.com/@${author.uniqueId}`
                : null,
        },

        // ── Video stats ──
        stats: {
            playCount: stats.playCount ?? null,
            likeCount: stats.diggCount ?? null,
            commentCount: stats.commentCount ?? null,
            shareCount: stats.shareCount ?? null,
            collectCount: stats.collectCount ?? null,
        },

        // ── Video technical info ──
        video: {
            width: video.width || null,
            height: video.height || null,
            duration: video.duration || null,
            ratio: video.ratio || null,
            coverUrl: video.cover || video.originCover || null,
            dynamicCoverUrl: video.dynamicCover || null,
            downloadUrl: video.downloadAddr || null,
            format: video.format || null,
            bitrateInfo: (video.bitrateInfo || []).map((b) => ({
                bitrate: b.Bitrate,
                codecType: b.CodecType,
                playAddr: b.PlayAddr?.UrlList?.[0] || null,
            })),
        },

        // ── Music / Audio ──
        ...(scrapeMusic && {
            music: {
                id: music.id || null,
                title: music.title || null,
                authorName: music.authorName || null,
                original: music.original || false,
                coverUrl: music.coverMedium || music.coverThumb || null,
                duration: music.duration || null,
                playUrl: music.playUrl || null,
                album: music.album || null,
            },
        }),

        // ── Additional metadata ──
        isAd: item.isAd || false,
        duetEnabled: item.duetEnabled ?? null,
        stitchEnabled: item.stitchEnabled ?? null,
        shareEnabled: item.shareEnabled ?? null,
        diversificationId: item.diversificationId || null,
    };
}

/**
 * Maps raw TikTok API comment to clean output format.
 */
export function processComment(comment) {
    if (!comment) return null;

    const user = comment.user || {};
    return {
        commentId: comment.cid || null,
        text: comment.text || '',
        likeCount: comment.digg_count ?? 0,
        replyCount: comment.reply_comment_total ?? 0,
        createTime: comment.create_time
            ? new Date(comment.create_time * 1000).toISOString()
            : null,
        user: {
            userId: user.uid || null,
            uniqueId: user.unique_id || null,
            nickname: user.nickname || null,
            avatarUrl: user.avatar_thumb?.url_list?.[0] || null,
            verified: user.custom_verify ? true : false,
        },
    };
}
