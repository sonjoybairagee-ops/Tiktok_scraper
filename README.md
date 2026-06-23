# TikTok Scraper

Extract data from TikTok — videos, hashtags, profiles, search results, comments, and music info.

## Features

- **Hashtag scraping** — Scrape videos from any hashtag (e.g. `#viral`, `#funny`)
- **Profile scraping** — Get all videos + full profile info for any TikTok account
- **Video URL scraping** — Scrape specific videos directly by URL
- **Search keyword scraping** — Search TikTok and get results for any keyword
- **Comments** — Optional: scrape top comments for each video
- **Music/Audio info** — Get song title, author, and audio details

## Input

| Field | Type | Description |
|-------|------|-------------|
| `hashtags` | `string[]` | Hashtags to scrape (without `#`) |
| `profiles` | `string[]` | Usernames to scrape (without `@`) |
| `videoUrls` | `string[]` | Direct TikTok video URLs |
| `searchKeywords` | `string[]` | Keywords to search |
| `maxVideosPerSource` | `number` | Max videos per input (default: 20) |
| `scrapeComments` | `boolean` | Whether to scrape comments (default: false) |
| `maxCommentsPerVideo` | `number` | Max comments per video (default: 20) |
| `scrapeMusic` | `boolean` | Whether to include music info (default: true) |
| `proxyConfiguration` | `object` | Proxy settings (Apify Residential recommended) |

## Output

Each result is saved to the **Dataset**. Example output for a video:

```json
{
  "type": "video",
  "sourceLabel": "hashtag:viral",
  "videoId": "7123456789012345678",
  "videoUrl": "https://www.tiktok.com/@user/video/7123456789012345678",
  "description": "This is so funny 😂 #viral #funny",
  "hashtags": ["viral", "funny"],
  "createTime": "2024-01-15T10:30:00.000Z",
  "author": {
    "uniqueId": "some_user",
    "nickname": "Some User",
    "verified": false,
    "followerCount": 125000,
    "followingCount": 300,
    "heartCount": 2500000,
    "videoCount": 87
  },
  "stats": {
    "playCount": 1500000,
    "likeCount": 85000,
    "commentCount": 1200,
    "shareCount": 4500,
    "collectCount": 3200
  },
  "video": {
    "width": 1080,
    "height": 1920,
    "duration": 30,
    "coverUrl": "https://..."
  },
  "music": {
    "title": "original sound",
    "authorName": "some_user",
    "original": true,
    "duration": 30
  },
  "comments": [
    {
      "username": "commenter1",
      "text": "This is hilarious!",
      "likeCount": "234",
      "timestamp": "2d ago"
    }
  ]
}
```

## Proxy

**Residential proxies are required.** TikTok blocks datacenter IPs aggressively. Use Apify Residential Proxy for best results.

## Cost estimate

| Action | Approx. cost |
|--------|-------------|
| 100 videos (no comments) | ~$0.50 |
| 100 videos + comments | ~$1.50 |
| 1 profile (50 videos) | ~$0.30 |

## Notes

- TikTok frequently changes its website structure. If scraped data is missing, the actor may need an update.
- Scraping is rate-limited intentionally to avoid bans.
- This actor uses **Playwright** with stealth fingerprinting to mimic real browsers.
