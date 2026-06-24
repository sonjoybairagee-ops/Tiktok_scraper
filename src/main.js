import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import { buildRequests } from './requestBuilder.js';
import { interceptApiResponses } from './interceptor.js';
import { processVideoItems, processComment } from './dataProcessor.js';

await Actor.init();

let input = await Actor.getInput();

// Fallback default input — prevents crash when Apify's automated QA test
// runs the actor with no input or an empty prefilled schema.
if (!input || Object.keys(input).length === 0 ||
    (!input.hashtags?.length && !input.profiles?.length && !input.videoUrls?.length && !input.searchKeywords?.length)) {
    log.warning('No usable input provided — falling back to default sample input.');
    input = {
        ...input,
        hashtags: input?.hashtags?.length ? input.hashtags : ['funnyvideos'],
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

    async requestHandler({ page, request }) {
        const { type, sourceLabel } = request.userData;
        log.info(`[${type}] Processing: ${request.url}`);

        // Set realistic user agent
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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
        }

        // Wait for TikTok's JS to boot and make API calls
        // Try waiting for a known TikTok element first
        try {
            await page.waitForSelector(
                '[data-e2e="challenge-item"], [data-e2e="user-post-item"], [data-e2e="search_video-item"], #SIGI_STATE, #__UNIVERSAL_DATA_FOR_REHYDRATION__',
                { timeout: 15000 }
            );
            log.info('TikTok content element found');
        } catch {
            log.warning('Timed out waiting for TikTok elements — will still try to extract data');

            // DEBUG: capture what was actually served so we can diagnose
            // CAPTCHA / bot-detection vs outdated selectors vs empty page.
            try {
                const pageTitle = await page.title();
                const pageUrl = page.url();
                const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
                log.warning(`DEBUG page info — title: "${pageTitle}", url: ${pageUrl}`);
                log.warning(`DEBUG body text snippet: ${bodyText.replace(/\s+/g, ' ')}`);

                const screenshotBuffer = await page.screenshot({ fullPage: false });
                const kvStore = await Actor.openKeyValueStore();
                const key = `DEBUG-SCREENSHOT-${Date.now()}`;
                await kvStore.setValue(key, screenshotBuffer, { contentType: 'image/png' });
                log.warning(`DEBUG screenshot saved to key-value store as "${key}" — check Storage tab.`);
            } catch (debugErr) {
                log.warning(`DEBUG capture failed: ${debugErr.message}`);
            }
        }

        // Additional wait for API responses to arrive
        await page.waitForTimeout(4000 + Math.random() * 2000);

        // Scroll to trigger more API calls (for list pages)
        if (type !== 'VIDEO') {
            log.info('Scrolling to trigger more API calls...');
            for (let i = 0; i < 4; i++) {
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
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
        const toProcess = videoItems.slice(0, remaining);

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
