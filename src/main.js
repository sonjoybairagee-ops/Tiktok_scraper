import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';

// Mock the missing imports until you provide those files
// These functions should exist in your project, otherwise the scraper will crash
const interceptApiResponses = async (page, type) => {
    // This is a placeholder. Replace with your actual implementation from './interceptor.js'
    return {
        getResults: async () => ({ videoItems: [], profileData: null, nextCursor: null, hasMore: false })
    };
};

const processVideoItems = (item, opts) => {
    // This is a placeholder. Replace with your actual implementation from './dataProcessor.js'
    return item; // Return processed item
};

await Actor.init();

let input = await Actor.getInput();

// Fallback default input — prevents crash when Apify's automated QA test
// runs the actor with no input or an empty prefilled schema.
if (!input || Object.keys(input).length === 0 ||
    (!input.hashtags?.length && !input.profiles?.length && !input.videoUrls?.length && !input.searchKeywords?.length)) {
    log.warning('No usable input provided — falling back to default sample input.');
    input = {
        ...input,
        hashtags: input?.hashtags?.length ? input.hashtags : ['funny'],
    };
}

const {
    hashtags = [],
    profiles = [],
    videoUrls = [],
    searchKeywords = [],
    maxVideosPerSource = 20,
    scrapeComments = false,
    maxCommentsPerVideo = 20,
    scrapeMusic = true,
    proxyConfiguration: proxyConfig,
} = input;

log.info('Starting TikTok Scraper (API Intercept + HTML Fallback Mode)...', {
    hashtags: hashtags.length,
    profiles: profiles.length,
    videoUrls: videoUrls.length,
    searchKeywords: searchKeywords.length,
});

const proxyConfiguration = await Actor.createProxyConfiguration(proxyConfig);
const requestQueue = await RequestQueue.open();
const sourceVideoCount = {};

// Build initial requests (you need to implement this function or import it)
// Placeholder for now
const buildRequests = ({ hashtags, profiles, videoUrls, searchKeywords }) => {
    const requests = [];
    // Implement based on your needs
    // This is a placeholder implementation
    for (const tag of hashtags) {
        requests.push({
            url: `https://www.tiktok.com/tag/${encodeURIComponent(tag)}`,
            userData: { type: 'HASHTAG', sourceLabel: `hashtag:${tag}` }
        });
    }
    return requests;
};

const initialRequests = buildRequests({ hashtags, profiles, videoUrls, searchKeywords });
for (const req of initialRequests) {
    await requestQueue.addRequest(req);
    sourceVideoCount[req.userData.sourceLabel] = 0;
}

const crawler = new PlaywrightCrawler({
    requestQueue,
    proxyConfiguration,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
            ],
        },
    },
    browserPoolOptions: {
        useFingerprints: true,
    },
    maxConcurrency: 1, // reduce concurrency to avoid TikTok blocking
    requestHandlerTimeoutSecs: 240,
    maxRequestRetries: 2,

    async requestHandler({ page, request, session }) {
        const { type, sourceLabel } = request.userData;
        log.info(`[${type}] Processing: ${request.url}`);

        // ── CRITICAL: Anti-Bot Script Injection ──
        await page.addInitScript(() => {
            // Hide automation
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
            Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.' });
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
            delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
            window.chrome = { runtime: {} };
        });

        // Set realistic headers
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
        });

        // Set up response listener BEFORE navigation
        const interceptedData = await interceptApiResponses(page, type);

        // Block heavy resources only — allow XHR/fetch/JSON
        await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf,otf,mp4,mp3,ico}', (route) => route.abort());

        // Navigate — use 'domcontentloaded' instead of 'networkidle' (faster, more reliable)
        try {
            await page.goto(request.url, {
                waitUntil: 'domcontentloaded',
                timeout: 60000,
            });
        } catch (e) {
            log.warning(`Navigation issue for ${request.url}: ${e.message} — continuing`);
            session?.retire();
            throw e;
        }

        // Wait for TikTok's JS to boot and make API calls
        try {
            await page.waitForSelector(
                '[data-e2e="challenge-item"], [data-e2e="user-post-item"], [data-e2e="search_video-item"], #SIGI_STATE, #__UNIVERSAL_DATA_FOR_REHYDRATION__',
                { timeout: 15000 }
            );
            log.info('TikTok content element found');
        } catch {
            log.warning('Timed out waiting for TikTok elements — will still try to extract data');

            // Check for CAPTCHA
            const title = await page.title();
            if (title.includes('Verify') || title.includes('captcha') || title.includes('bot')) {
                log.error('CAPTCHA detected! Retiring session.');
                session?.retire();
                throw new Error('Bot detection triggered');
            }
        }

        // Random wait for API responses to arrive
        await page.waitForTimeout(4000 + Math.random() * 2000);

        // Scroll to trigger more API calls (for list pages)
        if (type !== 'VIDEO') {
            log.info('Scrolling to trigger more API calls...');
            // Try to find the main scrollable container
            const scrollContainer = await page.evaluate(() => {
                const containers = document.querySelectorAll('div, section, main, ul');
                for (const el of containers) {
                    if (el.scrollHeight > window.innerHeight * 2) return el === document.body ? null : el;
                }
                return null;
            });

            for (let i = 0; i < 4; i++) {
                if (scrollContainer) {
                    await page.evaluate((container) => {
                        container.scrollTop = container.scrollHeight;
                    }, scrollContainer);
                } else {
                    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                }
                await page.waitForTimeout(2500 + Math.random() * 1000);
            }
            await page.waitForTimeout(2000);
        }

        // Get intercepted + HTML-extracted results
        const { videoItems, profileData, nextCursor, hasMore } = await interceptedData.getResults();

        log.info(`[${type}] Total collected: ${videoItems.length} video items`);

        // Save profile data
        if (profileData) {
            await Actor.pushData({ ...profileData, type: 'profile', sourceLabel });
            log.info(`Saved profile: @${profileData.uniqueId}`);
        }

        // Save videos up to limit
        const currentCount = sourceVideoCount[sourceLabel] || 0;
        const remaining = maxVideosPerSource - currentCount;
        const toProcess = videoItems.slice(0, Math.min(remaining, videoItems.length));

        for (const item of toProcess) {
            const video = processVideoItems(item, { sourceLabel, scrapeMusic });
            if (video) {
                let result = { ...video, type: 'video', sourceLabel };

                if (scrapeComments && type === 'VIDEO') {
                    const comments = await scrapeVideoComments(page, maxCommentsPerVideo);
                    result.comments = comments;
                }

                await Actor.pushData(result);
                sourceVideoCount[sourceLabel] = (sourceVideoCount[sourceLabel] || 0) + 1;
                log.info(`✅ Saved: ${video.videoId} | Views: ${video.stats?.playCount?.toLocaleString?.() ?? 'N/A'}`);
            }
        }

        // Paginate if needed
        const collected = sourceVideoCount[sourceLabel] || 0;
        if (hasMore && nextCursor && collected < maxVideosPerSource && type !== 'VIDEO') {
            const nextUrl = `${request.url.split('?')[0]}?cursor=${nextCursor}`;
            await requestQueue.addRequest({
                url: nextUrl,
                userData: { type, sourceLabel, cursor: nextCursor },
                uniqueKey: `${sourceLabel}_${nextCursor}`,
            });
            log.info(`Enqueued next page (cursor: ${nextCursor})`);
        }
    },

    failedRequestHandler({ request, error }) {
        log.error(`Failed: ${request.url}`, { error: error.message });
    },
});

await crawler.run();

const dataset = await Actor.openDataset();
const { itemCount } = await dataset.getInfo();
log.info(`✅ Finished! Total items saved: ${itemCount}`);

await Actor.exit();

async function scrapeVideoComments(page, maxComments) {
    try {
        await page.waitForSelector('[data-e2e="comment-list"]', { timeout: 8000 });
        const panel = await page.$('[data-e2e="comment-list"]');
        if (!panel) return [];

        let prev = 0, attempts = 0;
        while (attempts < 8) {
            await page.evaluate((el) => { el.scrollTop = el.scrollHeight; }, panel);
            await page.waitForTimeout(1500);
            const count = await page.evaluate((el) =>
                el.querySelectorAll('[data-e2e="comment-item"]').length, panel);
            if (count >= maxComments || count === prev) break;
            prev = count;
            attempts++;
        }

        return await page.evaluate((max) => {
            return Array.from(document.querySelectorAll('[data-e2e="comment-item"]'))
                .slice(0, max)
                .map((el) => ({
                    username: el.querySelector('[data-e2e="comment-username-1"]')?.textContent?.trim() || null,
                    text: el.querySelector('[data-e2e="comment-text"]')?.textContent?.trim() || null,
                    likeCount: el.querySelector('[data-e2e="comment-like-count"]')?.textContent?.trim() || '0',
                })).filter((c) => c.text);
        }, maxComments);
    } catch {
        return [];
    }
}
