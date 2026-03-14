const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 8002;
const PUBLIC_DIR = __dirname;
const IS_WIN = process.platform === 'win32';
const YTDLP_PATH = path.join(os.tmpdir(), IS_WIN ? 'yt-dlp.exe' : 'yt-dlp');
let FFMPEG_BINARY = ffmpegPath;

// ============================================================
// Cookie file support (required for YouTube bot bypass)
// Supports multiple files for rotation: cookies.txt, cookies1.txt, cookies2.txt, etc.
// ============================================================
function findCookieFiles() {
    const files = [];
    const possible = ['cookies.txt', 'cookies1.txt', 'cookies2.txt', 'cookies3.txt', 'youtube.com_cookies.txt'];
    for (const f of possible) {
        const p = path.join(__dirname, f);
        if (fs.existsSync(p)) files.push(p);
    }
    return files;
}

function getActiveCookie(attempt = 1) {
    const files = findCookieFiles();
    if (files.length === 0) return null;
    // Simple rotation or random selection
    return files[(attempt - 1) % files.length];
}

const YOUTUBE_PROXY = process.env.YOUTUBE_PROXY || null;

// Support for Automated PO Token Generator
function getPoTokenArgs() {
    try {
        const poTokenPath = path.join(__dirname, 'po_token.txt');
        const visitorDataPath = path.join(__dirname, 'visitor_data.txt');
        
        if (fs.existsSync(poTokenPath) && fs.existsSync(visitorDataPath)) {
            const poToken = fs.readFileSync(poTokenPath, 'utf8').trim();
            const visitorData = fs.readFileSync(visitorDataPath, 'utf8').trim();
            
            if (poToken && visitorData) {
                // Use the web client context as it's the most common for these generators
                // Syntax: youtube:po_token=web.gvs+TOKEN;visitor_data=DATA
                return `youtube:po_token=web.gvs+${poToken};visitor_data=${visitorData}`;
            }
        }
    } catch (e) {
        console.error('[po-token] Error reading token files:', e.message);
    }
    return null;
}

// This function seems to be a partial copy of the original findCookieFile's end.
// Assuming it's meant to be a separate function for some logging or specific cookie handling.
// If it was meant to be part of findCookieFile, the instruction was ambiguous.
// Given the instruction's structure, it's placed as a new function.
function findLogPath() {
    const tmp = path.join(os.tmpdir(), 'yt_cookies.txt'); // Define tmp here as it's used below
    if (process.env.YOUTUBE_COOKIES) {
        try {
            const content = Buffer.from(process.env.YOUTUBE_COOKIES, 'base64').toString('utf8');
            if (content.length > 10) {
                fs.writeFileSync(tmp, content, 'utf8');
                return tmp;
            }
        } catch(e) {}
    }
    return null;
}


function checkFfmpeg() {
    try {
        if (FFMPEG_BINARY) {
            execSync(`"${FFMPEG_BINARY}" -version`, { stdio: 'ignore' });
            return true;
        }
    } catch (_) {}
    // Try to resolve system ffmpeg full path (yt-dlp needs full path for --ffmpeg-location)
    try {
        const fullPath = execSync('which ffmpeg').toString().trim();
        if (fullPath) {
            execSync(`"${fullPath}" -version`, { stdio: 'ignore' });
            FFMPEG_BINARY = fullPath;
            console.log(`[ffmpeg] Found system ffmpeg at: ${fullPath}`);
            return true;
        }
    } catch (_) {}
    return false;
}

// ============================================================
// Bootstrap: download yt-dlp using Node.js built-in https
// (no curl, no wget needed — works on any Railway container)
// ============================================================
function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(dest);
        const protocol = url.startsWith('https') ? https : http;

        console.log(`Downloading: ${url}`);
        protocol.get(url, (res) => {
            // Follow redirects (GitHub gives 302)
            if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
                file.close();
                fs.unlinkSync(dest);
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                file.close();
                return reject(new Error(`Download failed with status ${res.statusCode}`));
            }
            res.pipe(file);
            file.on('finish', () => {
                file.close();
                try {
                    if (!IS_WIN) {
                        execSync(`chmod a+rx ${dest}`);
                    }
                    console.log(`yt-dlp downloaded and ready at ${dest}`);
                    resolve(dest);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', (err) => {
            file.close();
            try { fs.unlinkSync(dest); } catch (_) { }
            reject(err);
        });
    });
}

// ============================================================
// Self-update yt-dlp binary (run -U flag to get latest)
// ============================================================
let ytDlpUpdateInProgress = false;

async function updateYtDlp(binaryPath) {
    if (ytDlpUpdateInProgress) return;
    ytDlpUpdateInProgress = true;
    console.log('[yt-dlp] Running self-update (-U)...');
    return new Promise((resolve) => {
        // On Linux we need to copy to a writable location first if it's read-only
        const updateTarget = binaryPath === 'yt-dlp' ? YTDLP_PATH : binaryPath;

        // If binary path is 'yt-dlp' (system), we update the /tmp copy instead
        // We explicitly use the nightly channel here as stable gets blocked quickly on VPS IPs
        const proc = spawn(updateTarget, ['--update-to', 'nightly'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.stderr.on('data', d => { out += d.toString(); });
        proc.on('close', (code) => {
            ytDlpUpdateInProgress = false;
            // Nightly updates often output "updated to" or "up to date"
            if (code === 0 || out.toLowerCase().includes('up to date') || out.toLowerCase().includes('updated')) {
                console.log('[yt-dlp] Update result:', out.trim().slice(0, 200));
            } else {
                console.warn('[yt-dlp] Update exited with code', code, out.slice(0, 200));
            }
            resolve();
        });
        proc.on('error', (e) => {
            ytDlpUpdateInProgress = false;
            console.warn('[yt-dlp] Update error (non-fatal):', e.message);
            resolve();
        });
        // Safety timeout: 2 minutes max for update
        setTimeout(() => {
            ytDlpUpdateInProgress = false;
            try { proc.kill('SIGKILL'); } catch(_) {}
            resolve();
        }, 2 * 60 * 1000);
    });
}

async function ensureYtDlp() {
    // 1. Try pre-downloaded binary in /tmp (most reliable on Railway — full write access)
    if (fs.existsSync(YTDLP_PATH)) {
        try {
            execSync(`"${YTDLP_PATH}" --version`, { stdio: 'ignore' });
            console.log(`Using cached yt-dlp at ${YTDLP_PATH}`);
            // Run update in background — don't block startup
            updateYtDlp(YTDLP_PATH).catch(() => {});
            return YTDLP_PATH;
        } catch (_) {
            console.log(`Cached binary at ${YTDLP_PATH} failed to execute. Re-downloading...`);
            try { fs.unlinkSync(YTDLP_PATH); } catch (e) { }
        }
    }

    // 2. Try bundled binary from youtube-dl-exec (make it executable)
    const bundledName = IS_WIN ? 'yt-dlp.exe' : 'yt-dlp';
    const bundled = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', bundledName);
    if (fs.existsSync(bundled)) {
        try {
            if (!IS_WIN) execSync(`chmod a+rx ${bundled}`, { stdio: 'ignore' });
            execSync(`"${bundled}" --version`, { stdio: 'ignore' });
            console.log(`Using bundled yt-dlp at ${bundled}`);
            // Copy bundled to /tmp so we can self-update it there
            try {
                fs.copyFileSync(bundled, YTDLP_PATH);
                if (!IS_WIN) execSync(`chmod a+rx ${YTDLP_PATH}`, { stdio: 'ignore' });
                updateYtDlp(YTDLP_PATH).catch(() => {});
                return YTDLP_PATH;
            } catch(_) {}
            return bundled;
        } catch (_) { }
    }

    // 3. Download fresh latest binary using Node.js built-in https (NIGHTLY CHANNEL)
    console.log('Downloading latest nightly yt-dlp via Node.js https...');
    const downloadUrl = IS_WIN
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' // NOTE: Nightly exact binary names vary, but yt-dlp fallback download mechanism handles this via the -U nightly command. We just grab stable first, then force the initial update to nightly.
        : (process.platform === 'linux'
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp');

    // Download stable first to bootstrap, but our ensureYtDlp immediately runs updateYtDlp
    await downloadFile(downloadUrl, YTDLP_PATH);
    
    // Force immediate switch to nightly
    await updateYtDlp(YTDLP_PATH);
    
    return YTDLP_PATH;
}

// ============================================================
// Content-Type helper
// ============================================================
function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const map = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
    };
    return map[ext] || 'application/octet-stream';
}

// ============================================================
// Download handler
// ============================================================
async function handleDownload(parsedUrl, req, res, YTDLP_BINARY) {
    const videoUrl = parsedUrl.searchParams.get('url');
    const quality = parsedUrl.searchParams.get('quality') || '720';
    const type = parsedUrl.searchParams.get('type') || 'video';
    
    if (!videoUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ status: 'error', message: 'Missing url parameter.' }));
    }

    const isAudio = type === 'audio' || quality === 'audio';
    const rawTitle = parsedUrl.searchParams.get('title') || 'video';
    const safeTitle = rawTitle.replace(/[\\/:"*?<>|]/g, '_').substring(0, 100) || 'download';

    const isYouTube = videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be');
    const isInstagram = videoUrl.includes('instagram.com');

    const tempId = Date.now() + Math.floor(Math.random() * 10000);
    const tempFileTemplate = path.join(os.tmpdir(), `dl_${tempId}.%(ext)s`);

    // Base bypass — no youtube-specific args on other platforms (causes errors)
    const activeCookie = getActiveCookie();
    const GENERAL_BYPASS = [
        '--no-cache-dir',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--force-ipv4',
        '--socket-timeout', '60',
        '--js-runtimes', 'node', // Explicitly use node for signature extraction
        '--geo-bypass',
        '--no-check-certificate',
        ...(isYouTube && activeCookie ? ['--cookies', activeCookie] : []),
        ...(isYouTube && YOUTUBE_PROXY ? ['--proxy', YOUTUBE_PROXY] : [])
    ];

    // Direct streaming arguments
    const args = isAudio
        ? [
            videoUrl, '--no-playlist',
            // Best audio: prefer m4a/aac for conversion to mp3, fallback to any audio
            '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio',
            '-x', '--audio-format', 'mp3', '--audio-quality', '0',
            '-o', '-', // Stream to stdout
            '--ffmpeg-location', FFMPEG_BINARY,
            '--no-warnings', '--no-part',
            ...GENERAL_BYPASS
        ]
        : [
            videoUrl, '--no-playlist',
            // For NON-YouTube, favor single-file formats (better for streaming)
            // For YouTube, use best quality (merging handled by yt-dlp to stdout)
            '-f', (() => {
                if (isYouTube) {
                    // Prioritize single-file MP4 for stable stdout streaming, fallback to merged
                    return `best[height<=${quality}][ext=mp4]/bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`;
                }
                const isFacebook = videoUrl.includes('facebook.com') || videoUrl.includes('fb.watch');
                if (isFacebook) {
                    // Facebook specific: use hd/sd labels since height is often missing
                    return (quality > 480) ? 'hd/sd/best' : 'sd/best[height<=480]/best';
                }
                return `best[height<=${quality}][ext=mp4]/best[height<=${quality}]/best`;
            })(),
            '--merge-output-format', 'mp4',
            '-o', '-', // Stream to stdout
            '--ffmpeg-location', FFMPEG_BINARY,
            '--no-warnings', '--no-part',
            ...GENERAL_BYPASS
        ];

    let finished = false;
    let subprocess = null;

    // Instagram often hangs waiting for login — use 60s timeout instead of 5 minutes
    const timeoutMs = isInstagram ? 60 * 1000 : 5 * 60 * 1000;

    const timeout = setTimeout(() => {
        if (!finished && subprocess) {
            subprocess.kill('SIGKILL');
            fail(new Error(
                isInstagram
                    ? 'Instagram requires login to download — not supported on this server.'
                    : 'Download timed out after 5 minutes.'
            ));
        }
    }, timeoutMs);

    const fail = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        const errMsg = err?.message || err || 'Unknown error';
        console.error(`[download] Error for ${videoUrl}:`, errMsg);
        
        // Try to clean up any file starting with this tempId
        try {
            const dirFiles = fs.readdirSync(os.tmpdir());
            const file = dirFiles.find(f => f.startsWith(`dl_${tempId}.`));
            if (file) fs.unlink(path.join(os.tmpdir(), file), () => {});
        } catch (e) {}

        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            const errLower = errMsg.toLowerCase();
            let userMessage = 'Download failed. Please try again.';
            // Only show cookie error for Instagram or explicit login-required errors (not just URL mentions of cookies)
            const isLoginError = errLower.includes('sign in') || errLower.includes('login required') || errLower.includes('private video');
            const isCookieError = isInstagram || (isLoginError && (errLower.includes('cookie') || errLower.includes('authentication')));
            if (isCookieError) {
                userMessage = 'Download failed — this platform requires login. Instagram is not supported.';
            } else if (errLower.includes('sign in to confirm') || errLower.includes('bot')) {
                userMessage = 'YouTube Bot Block: Please update cookies.txt with fresh cookies from your browser.';
            } else if (errLower.includes('timed out') || errMsg.includes('timed out')) {
                userMessage = 'Download timed out. The file might be too large or the server is slow.';
            } else if (isYouTube) {
                userMessage = 'YouTube download failed. The server may be blocked — try again in a moment.';
            } else {
                userMessage = 'Download failed. Please check the URL and try again.';
            }
            res.end(JSON.stringify({ status: 'error', message: userMessage, details: errMsg.slice(0, 150) }));
        } else {
            try { res.end(); } catch (_) { }
        }
    };

    async function runDownload(attempt = 1) {
        return new Promise((resolve) => {
            // Android-first Strategy (optimized for restricted videos):
            // Attempt 1: android,ios (Bypasses most PO Token/Bot blocks)
            // Attempt 2: tv_embedded (Stable fallback)
            const client = attempt === 1 ? 'android,ios' : 'tv_embedded';
            
            console.log(`[download] Attempt ${attempt} for ${videoUrl} using client: ${client}`);

            const dlArgs = [
                ...args
            ];

            // Re-apply cookies for this specific attempt if we have rotation
            if (isYouTube) {
                const currentCookie = getActiveCookie(attempt);
                if (currentCookie) {
                    // Remove any existing --cookies from base args if present
                    const cookieIdx = dlArgs.indexOf('--cookies');
                    if (cookieIdx !== -1) {
                        dlArgs.splice(cookieIdx, 2);
                    }
                    dlArgs.push('--cookies', currentCookie);
                }
            }

            if (isYouTube) {
                // Merge attempt-specific client with global PO Token args
                let finalExtractorArgs = `youtube:player_client=${client}`;
                const globalPo = getPoTokenArgs(); // Returns "youtube:po_token=...;visitor_data=..."
                if (globalPo) {
                    // Extract only the args after "youtube:"
                    const poParts = globalPo.split(':')[1];
                    finalExtractorArgs += `;${poParts}`;
                }
                dlArgs.push('--extractor-args', finalExtractorArgs);
            }

            const env = Object.assign({}, process.env);

            const proc = spawn(YTDLP_BINARY, dlArgs, { stdio: ['ignore', 'pipe', 'pipe'], env });
            let stderr = '';
            let headersSent = false;
            
            proc.stdout.on('data', () => {
                if (!headersSent && !finished) {
                    headersSent = true;
                    finished = true; // Mark as "in progress" so fail() doesn't send JSON
                    clearTimeout(timeout);
                    
                    const actualExt = isAudio ? 'mp3' : 'mp4';
                    let contentType = isAudio ? 'audio/mpeg' : 'video/mp4';

                    const encodedFileName = encodeURIComponent(`${safeTitle}.${actualExt}`);
                    res.writeHead(200, {
                        'Content-Type': contentType,
                        'Content-Disposition': `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
                        'Access-Control-Allow-Origin': '*',
                        'Access-Control-Expose-Headers': 'Content-Disposition'
                    });
                }
            });

            proc.stdout.pipe(res);
            proc.stderr.on('data', d => { stderr += d.toString(); });

            proc.on('close', (code) => {
                if (!headersSent) {
                    // Fail on this attempt
                    console.warn(`[download] Attempt ${attempt} failed. Code: ${code} Stderr: ${stderr.slice(-500)}`);
                    
                    if (attempt < 2 && !finished) {
                        console.log('[download] Retrying with fallback client...');
                        runDownload(attempt + 1).then(resolve);
                    } else {
                        fail(new Error(`yt-dlp failed after ${attempt} attempts. ${stderr.slice(-200)}`));
                        resolve();
                    }
                } else {
                    console.log(`[download] Stream finished for ${videoUrl} with code ${code}`);
                    res.end();
                    resolve();
                }
            });

            proc.on('error', (err) => {
                console.error(`[download] Process error on attempt ${attempt}:`, err);
                if (!headersSent) {
                    if (attempt < 2 && !finished) {
                        runDownload(attempt + 1).then(resolve);
                    } else {
                        fail(err);
                        resolve();
                    }
                } else {
                    res.end();
                    resolve();
                }
            });

            // Link the root subprocess to this attempt for timeout killing
            subprocess = proc;
        });
    }

    req.on('close', () => {
        if (subprocess && !finished) subprocess.kill('SIGKILL');
        finished = true;
        clearTimeout(timeout);
    });

    // Start the download chain
    runDownload(1).catch(fail);
}

// ============================================================
// Main: bootstrap yt-dlp then start server
// ============================================================
ensureYtDlp().then((YTDLP_BINARY) => {
    console.log(`yt-dlp ready: ${YTDLP_BINARY}`);

    // Resolve FFMPEG path at startup so downloads use the correct binary
    checkFfmpeg();
    console.log(`ffmpeg ready: ${FFMPEG_BINARY}`);

    // Load YouTube cookies (required for bot bypass on server IPs)
    const cookieFiles = findCookieFiles();
    if (cookieFiles.length > 0) {
        console.log(`[cookies] Found ${cookieFiles.length} cookie files for rotation.`);
    } else {
        console.warn('[cookies] No YouTube cookies found. YouTube downloads may fail with bot check.');
    }

    // ============================================================
    // Auto-update yt-dlp every 6 hours to keep YouTube working
    // This is the ROOT CAUSE fix: yt-dlp goes stale -> YouTube breaks
    // ============================================================
    const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    setInterval(() => {
        console.log('[yt-dlp] Running scheduled auto-update...');
        updateYtDlp(YTDLP_BINARY).catch(() => {});
    }, UPDATE_INTERVAL_MS);

    const server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

        if (req.method === 'OPTIONS') {
            res.writeHead(200, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            return res.end();
        }

        if (parsedUrl.pathname === '/debug-status') {
            const cookies = findCookieFiles();
            const hasPoToken = !!process.env.YOUTUBE_PO_TOKEN;
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ 
                status: 'ok', 
                cookies_found: cookies.length > 0,
                cookies_count: cookies.length,
                po_token_found: hasPoToken,
                yt_dlp_binary: YTDLP_BINARY,
                platform: process.platform,
                arch: process.arch,
                node_version: process.version
            }));
        }

        if (parsedUrl.pathname === '/health') {
            const ffmpegOk = checkFfmpeg();

            let ytdlpVersion = 'unknown';
            try {
                ytdlpVersion = execSync(`"${YTDLP_BINARY}" --version`).toString().trim();
            } catch (_) { }

            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ 
                status: 'ok', 
                version: '2026-03-14-v3', // Increment version
                ytdlp: YTDLP_BINARY, 
                ytdlp_version: ytdlpVersion,
                ffmpeg: ffmpegOk ? FFMPEG_BINARY : 'not found' 
            }));
        }

        // Debug: test yt-dlp with a real download to measure time and speed
        if (parsedUrl.pathname === '/api/test') {
            const testUrl = parsedUrl.searchParams.get('url') || 'https://www.tiktok.com/@tiktok/video/7106594312292453675';

            // Use plain text so the browser streams it live
            res.writeHead(200, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'X-Content-Type-Options': 'nosniff' // force browsers to render immediately
            });
            res.write(`Starting yt-dlp test for url: ${testUrl}\n`);
            res.write(`Binary: ${YTDLP_BINARY}\n`);
            res.write(`FFMPEG: ${ffmpegPath}\n\n`);

            const tmpTestFile = path.join(os.tmpdir(), `test_${Math.random().toString(36).substring(2)}.mp4`);

            const env = Object.assign({}, process.env);
            env.PATH = path.dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');

            const testProc = spawn(YTDLP_BINARY, [
                testUrl, '--no-playlist',
                '-f', `bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/b[height<=720][ext=mp4]/b[height<=720]`,
                '--merge-output-format', 'mp4',
                '-o', tmpTestFile,
                '--ffmpeg-location', FFMPEG_BINARY,
                '--verbose'
            ], { stdio: ['ignore', 'pipe', 'pipe'], env });

            testProc.stdout.on('data', d => { res.write(`[STDOUT] ${d.toString()}`); });
            testProc.stderr.on('data', d => { res.write(`[STDERR] ${d.toString()}`); });

            const t = setTimeout(() => {
                res.write('\n\n[TIMEOUT] 60s reached, killing process...\n');
                testProc.kill('SIGKILL'); // Use SIGKILL to force die including ffmpeg
                res.end();
            }, 60000);

            testProc.on('close', (code) => {
                clearTimeout(t);
                res.write(`\n[CLOSE] yt-dlp exited with code ${code}\n`);
                try {
                    if (fs.existsSync(tmpTestFile)) {
                        const size = fs.statSync(tmpTestFile).size;
                        res.write(`[FILE] Output file size: ${size} bytes\n`);
                        fs.unlinkSync(tmpTestFile);
                    } else {
                        res.write(`[FILE] Output file does not exist.\n`);
                    }
                } catch (e) {
                    res.write(`[FILE ERROR] ${e.message}\n`);
                }
                res.end();
            });

            req.on('close', () => {
                clearTimeout(t);
                testProc.kill('SIGKILL');
            });
            return;
        }

        if (parsedUrl.pathname === '/api/download' && req.method === 'GET') {
            return handleDownload(parsedUrl, req, res, YTDLP_BINARY);
        }

        if (parsedUrl.pathname === '/api/info' && req.method === 'GET') {
            const videoUrl = parsedUrl.searchParams.get('url');
            if (!videoUrl) {
                res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                return res.end(JSON.stringify({ error: 'Missing url parameter' }));
            }

            const env = Object.assign({}, process.env);
            env.PATH = path.dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');

            const isYouTube = videoUrl.includes('youtube.com') || videoUrl.includes('youtu.be');

            // Android-first for metadata too
            // android,ios prioritized for better extraction on restricted videos
            const ytPlayerClients = [
                'android,ios',
                'tv_embedded'
            ];

            let clientDropped = false;
            req.on('close', () => { clientDropped = true; });

            async function tryFetchInfo(playerClient, attempt = 1) {
                const activeCookie = getActiveCookie(attempt);
                const poToken = process.env.YOUTUBE_PO_TOKEN || '';

                return new Promise((resolve) => {
                    const infoArgs = [
                        videoUrl, '--no-playlist', '--dump-json', '--no-warnings', '--no-cache-dir', '--force-ipv4',
                        '--socket-timeout', '20',
                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                        '--js-runtimes', 'node',
                        '--geo-bypass',
                        '--no-check-certificate',
                        ...(isYouTube && activeCookie ? ['--cookies', activeCookie] : []),
                        ...(isYouTube && YOUTUBE_PROXY ? ['--proxy', YOUTUBE_PROXY] : [])
                    ];

                    if (isYouTube) {
                        // Consolidate client + PO Token args
                        let ytArgs = `youtube:player_client=${playerClient}`;
                        const globalPo = getPoTokenArgs();
                        if (globalPo) {
                            const poParts = globalPo.split(':')[1];
                            ytArgs += `;${poParts}`;
                        }
                        infoArgs.push('--extractor-args', ytArgs);
                    }

                    const proc = spawn(YTDLP_BINARY, infoArgs, { env });
                    let buf = '';
                    let errBuf = '';
                    proc.stdout.on('data', c => buf += c);
                    proc.stderr.on('data', c => errBuf += c);
                    // 45s timeout per attempt
                    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_) {} }, 45000);
                    proc.on('close', (code) => {
                        clearTimeout(t);
                        try {
                            // Find the JSON block if there's extra text/warnings in stdout
                            const startIndex = buf.indexOf('{');
                            const endIndex = buf.lastIndexOf('}');
                            if (startIndex !== -1 && endIndex !== -1) {
                                const jsonStr = buf.substring(startIndex, endIndex + 1);
                                const data = JSON.parse(jsonStr);
                                if (data && data.title) return resolve({ success: true, data });
                            }
                        } catch(_) {}
                        resolve({ success: false, error: errBuf || 'Failed to parse yt-dlp output' });
                    });
                    proc.on('error', (e) => { clearTimeout(t); resolve({ success: false, error: e.message }); });
                });
            }

            // Try each player client until one succeeds
            let infoData = null;
            let lastError = '';
            const clientList = isYouTube ? ytPlayerClients : [null];
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (clientDropped || res.headersSent) return;
                const result = await tryFetchInfo(client || '', i + 1);
                if (result && result.success) {
                    infoData = result.data;
                    console.log(`[info] Success with client: ${client || 'default'}`);
                    break;
                } else if (result) {
                    console.error(`[info] Client ${client || 'default'} failed: ${result.error.slice(-200)}`);
                    lastError += `\n[Client: ${client || 'default'}] ${result.error}`;
                }
            }

            if (res.headersSent) return;

            let finalTitle = 'Video Download';
            let finalThumbnail = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?q=80&w=1000&auto=format&fit=crop';
            let duration = 'Auto';
            let formats = [];

            if (infoData) {
                if (infoData.title) finalTitle = infoData.title;
                if (infoData.thumbnail) finalThumbnail = infoData.thumbnail;
                if (infoData.duration_string) duration = infoData.duration_string;
                if (infoData.formats) formats = infoData.formats;
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ title: finalTitle, thumbnail: finalThumbnail, duration, formats }));
            } else {
                // If it completely fails, send the detailed stderr log back to the frontend for diagnosis
                res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: 'Failed to fetch video info. Detailed Error below:', details: lastError.slice(-1000) }));
            }
            return;
        }

        // Static files (local dev only)
        let pathname = parsedUrl.pathname === '/' ? '/index.html' : parsedUrl.pathname;
        const filePath = path.join(PUBLIC_DIR, pathname);
        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                return res.end('Not found');
            }
            res.writeHead(200, { 'Content-Type': getContentType(filePath) });
            fs.createReadStream(filePath).pipe(res);
        });
    });

    server.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
    });
}).catch((err) => {
    console.error('FATAL: Could not initialize yt-dlp:', err.message);
    process.exit(1);
});
