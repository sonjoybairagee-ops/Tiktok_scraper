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
