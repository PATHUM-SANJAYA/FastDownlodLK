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
const YTDLP_PATH = '/tmp/yt-dlp';

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
                    execSync(`chmod a+rx ${dest}`);
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

async function ensureYtDlp() {
    // 1. Try system yt-dlp
    try {
        execSync('yt-dlp --version', { stdio: 'ignore' });
        console.log('Using system yt-dlp');
        return 'yt-dlp';
    } catch (_) { }

    // 2. Try pre-downloaded binary in /tmp
    if (fs.existsSync(YTDLP_PATH)) {
        try {
            execSync(`${YTDLP_PATH} --version`, { stdio: 'ignore' });
            console.log(`Using cached yt-dlp at ${YTDLP_PATH}`);
            return YTDLP_PATH;
        } catch (_) { }
    }

    // 3. Try bundled binary from youtube-dl-exec (make it executable)
    const bundled = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp');
    if (fs.existsSync(bundled)) {
        try {
            execSync(`chmod a+rx ${bundled}`, { stdio: 'ignore' });
            execSync(`${bundled} --version`, { stdio: 'ignore' });
            console.log(`Using bundled yt-dlp at ${bundled}`);
            return bundled;
        } catch (_) { }
    }

    // 4. Download using Node.js built-in https (fallback — no curl/wget needed)
    console.log('Downloading yt-dlp via Node.js https...');
    await downloadFile(
        'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
        YTDLP_PATH
    );
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
    const rawTitle = parsedUrl.searchParams.get('title') || 'download';
    const safeTitle = rawTitle.replace(/[^a-z0-9 -]/gi, '_').substring(0, 150);

    if (!videoUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ status: 'error', message: 'Missing url parameter.' }));
    }

    const isAudio = type === 'audio' || quality === 'audio';
    const tempId = Math.random().toString(36).substring(2, 10);
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempFile = path.join(os.tmpdir(), `dl_${tempId}.${ext}`);

    const YOUTUBE_BYPASS = [
        '--extractor-args', 'youtube:player_client=ios,web',
        '--user-agent', 'com.google.ios.youtube/19.29.1 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X;)',
    ];

    const args = isAudio
        ? [
            videoUrl, '--no-playlist',
            '-x', '--audio-format', 'mp3', '--audio-quality', '5',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings',
            ...YOUTUBE_BYPASS,
        ]
        : [
            videoUrl, '--no-playlist',
            '-f', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/b[height<=${quality}][ext=mp4]/b[height<=${quality}]`,
            '--merge-output-format', 'mp4',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings',
            ...YOUTUBE_BYPASS,
        ];

    let finished = false;
    let subprocess = null;

    const timeout = setTimeout(() => {
        if (!finished && subprocess) {
            subprocess.kill('SIGTERM');
            fail(new Error('Download timed out.'));
        }
    }, 5 * 60 * 1000);

    const fail = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        console.error('Download error:', err?.message || err);
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => { });
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ status: 'error', message: 'Download failed. The video may be private, region-locked, or blocked.' }));
        } else {
            try { res.end(); } catch (_) { }
        }
    };

    try {
        subprocess = spawn(YTDLP_BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrBuffer = '';
        subprocess.stderr.on('data', d => { stderrBuffer += d.toString(); });
        subprocess.on('error', fail);
        subprocess.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);
            if (code !== 0 || !fs.existsSync(tempFile)) {
                return fail(new Error(stderrBuffer || `yt-dlp exited with code ${code}`));
            }
            try {
                const stats = fs.statSync(tempFile);
                if (stats.size < 1000) throw new Error('File too small — likely blocked.');
                res.writeHead(200, {
                    'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
                    'Content-Disposition': `attachment; filename="${safeTitle}.${ext}"`,
                    'Content-Length': stats.size,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': 'Content-Disposition',
                });
                const stream = fs.createReadStream(tempFile);
                stream.pipe(res);
                stream.on('end', () => fs.unlink(tempFile, () => { }));
                stream.on('error', (e) => { console.error('Stream err:', e); fs.unlink(tempFile, () => { }); });
                req.on('close', () => fs.unlink(tempFile, () => { }));
            } catch (err) { fail(err); }
        });
    } catch (err) { fail(err); }
}

// ============================================================
// Main: bootstrap yt-dlp then start server
// ============================================================
ensureYtDlp().then((YTDLP_BINARY) => {
    console.log(`yt-dlp ready: ${YTDLP_BINARY}`);

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

        if (parsedUrl.pathname === '/health') {
            // Also check ffmpeg
            let ffmpegOk = false;
            try {
                execSync(`chmod a+rx "${ffmpegPath}"`, { stdio: 'ignore' });
                execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
                ffmpegOk = true;
            } catch (_) { }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ status: 'ok', ytdlp: YTDLP_BINARY, ffmpeg: ffmpegOk ? ffmpegPath : 'not found' }));
        }

        // Debug: test yt-dlp with a real TikTok URL
        if (parsedUrl.pathname === '/api/test') {
            const testUrl = parsedUrl.searchParams.get('url') || 'https://www.tiktok.com/@tiktok/video/7106594312292453675';
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            const testProc = spawn(YTDLP_BINARY, [
                testUrl, '--no-playlist', '--dump-json', '--no-warnings',
                '--extractor-args', 'youtube:player_client=ios,web',
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            let out = '', err = '';
            testProc.stdout.on('data', d => out += d);
            testProc.stderr.on('data', d => err += d);
            const t = setTimeout(() => testProc.kill('SIGTERM'), 20000);
            testProc.on('close', (code) => {
                clearTimeout(t);
                let parsed = null;
                try { parsed = JSON.parse(out); } catch (_) { }
                res.end(JSON.stringify({
                    binary: YTDLP_BINARY,
                    ffmpegPath,
                    exitCode: code,
                    title: parsed?.title || null,
                    stderr: err.substring(0, 2000),
                    stdout_preview: out.substring(0, 500),
                }));
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

            const subprocess = spawn(YTDLP_BINARY, [
                videoUrl, '--no-playlist', '--dump-json', '--no-warnings',
                '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            ]);

            let stdoutBuffer = '';
            subprocess.stdout.on('data', c => stdoutBuffer += c);
            subprocess.stderr.on('data', () => { });
            const infoTimeout = setTimeout(() => subprocess.kill('SIGTERM'), 30000);

            subprocess.on('close', async () => {
                clearTimeout(infoTimeout);
                res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                let finalTitle = 'Video Download';
                let finalThumbnail = 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?q=80&w=1000&auto=format&fit=crop';
                let duration = 'Auto';
                let formats = [];
                try {
                    const data = JSON.parse(stdoutBuffer);
                    if (data.title) finalTitle = data.title;
                    if (data.thumbnail) finalThumbnail = data.thumbnail;
                    if (data.duration_string) duration = data.duration_string;
                    if (data.formats) formats = data.formats;
                } catch (_) { }

                if (finalTitle === 'Video Download') {
                    try {
                        const fr = await fetch(`https://api.microlink.io?url=${encodeURIComponent(videoUrl)}`);
                        if (fr.ok) {
                            const fd = await fr.json();
                            if (fd.data?.title) finalTitle = fd.data.title;
                            if (fd.data?.image?.url) finalThumbnail = fd.data.image.url;
                        }
                    } catch (_) { }
                }
                res.end(JSON.stringify({ title: finalTitle, thumbnail: finalThumbnail, duration, formats }));
            });
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
