/**
 * Builds initial Crawlee requests from all input sources.
 * For API intercept approach, we navigate to the actual TikTok pages
 * (not the API URLs) — TikTok's own JS will call the APIs, we just intercept.
 */
export function buildRequests({ hashtags, profiles, videoUrls, searchKeywords }) {
    const requests = [];

    for (const tag of hashtags) {
        const cleanTag = tag.replace(/^#/, '').trim();
        requests.push({
            url: `https://www.tiktok.com/tag/${cleanTag}`,
            userData: {
                type: 'HASHTAG',
                sourceLabel: `hashtag:${cleanTag}`,
            },
        });
    }

    for (const username of profiles) {
        const cleanUser = username.replace(/^@/, '').trim();
        requests.push({
            url: `https://www.tiktok.com/@${cleanUser}`,
            userData: {
                type: 'PROFILE',
                sourceLabel: `profile:${cleanUser}`,
            },
        });
    }

    for (const url of videoUrls) {
        requests.push({
            url: url.trim(),
            userData: {
                type: 'VIDEO',
                sourceLabel: `direct:${url.trim()}`,
            },
        });
    }

    for (const keyword of searchKeywords) {
        const encoded = encodeURIComponent(keyword.trim());
        requests.push({
            url: `https://www.tiktok.com/search?q=${encoded}`,
            userData: {
                type: 'SEARCH',
                sourceLabel: `search:${keyword.trim()}`,
            },
        });
    }

    return requests;
}
