const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { URL } = require('url');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 8002;
const PUBLIC_DIR = __dirname;

// --- yt-dlp binary: prefer system yt-dlp (Railway / Linux), fall back to bundled .exe on Windows ---
function getYtDlpBinary() {
    // Try system yt-dlp first (available after Railway build command)
    try {
        execSync('yt-dlp --version', { stdio: 'ignore' });
        return 'yt-dlp';
    } catch (_) { }

    // Fall back to bundled binary
    return path.join(
        __dirname,
        'node_modules',
        'youtube-dl-exec',
        'bin',
        process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
    );
}

const YTDLP_BINARY = getYtDlpBinary();
console.log('Using yt-dlp binary:', YTDLP_BINARY);

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case '.html': return 'text/html; charset=utf-8';
        case '.css': return 'text/css; charset=utf-8';
        case '.js': return 'text/javascript; charset=utf-8';
        case '.json': return 'application/json; charset=utf-8';
        case '.png': return 'image/png';
        case '.jpg':
        case '.jpeg': return 'image/jpeg';
        case '.svg': return 'image/svg+xml';
        default: return 'application/octet-stream';
    }
}

// ✅ FIX 1: Pass `req` as a parameter so we can clean up on client disconnect
async function handleDownload(parsedUrl, req, res) {
    const videoUrl = parsedUrl.searchParams.get('url');
    const quality = parsedUrl.searchParams.get('quality') || '720';
    const type = parsedUrl.searchParams.get('type') || 'video';
    const rawTitle = parsedUrl.searchParams.get('title') || 'download';

    // Sanitize title
    const safeTitle = rawTitle.replace(/[^a-z0-9 -]/gi, '_').substring(0, 150);

    if (!videoUrl) {
        res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({ status: 'error', message: 'Missing url parameter.' }));
    }

    const isAudio = type === 'audio' || quality === 'audio';
    const tempId = Math.random().toString(36).substring(2, 10);
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempFile = path.join(os.tmpdir(), `dl_${tempId}.${ext}`);

    const args = isAudio
        ? [
            videoUrl,
            '--no-playlist',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '5',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ]
        : [
            videoUrl,
            '--no-playlist',
            '-f', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/b[height<=${quality}][ext=mp4]/b[height<=${quality}]`,
            '--merge-output-format', 'mp4',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ];

    let finished = false;
    let subprocess = null;

    // ✅ FIX 2: Timeout - kill after 5 minutes if stuck
    const timeout = setTimeout(() => {
        if (!finished && subprocess) {
            subprocess.kill('SIGTERM');
            fail(new Error('Download timed out after 5 minutes.'));
        }
    }, 5 * 60 * 1000);

    const fail = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        console.error('yt-dlp failed:', err?.message || err);
        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => { });

        if (!res.headersSent) {
            res.writeHead(500, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({
                status: 'error',
                message: 'Download failed. The video might be private, region-locked, or blocked by bot-protection.',
            }));
        } else {
            try { res.end(); } catch (_) { }
        }
    };

    try {
        subprocess = spawn(YTDLP_BINARY, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let stderrBuffer = '';
        subprocess.stderr.on('data', data => {
            const text = data.toString();
            stderrBuffer += text;
            console.error('yt-dlp stderr:', text);
        });

        subprocess.on('error', fail);
        subprocess.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);

            if (code !== 0 || !fs.existsSync(tempFile)) {
                fail(new Error(stderrBuffer || `yt-dlp exited with code ${code}`));
                return;
            }

            try {
                const stats = fs.statSync(tempFile);
                if (stats.size < 1000) {
                    throw new Error('File too small — possibly blocked by bot protection.');
                }

                res.writeHead(200, {
                    'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
                    'Content-Disposition': `attachment; filename="${safeTitle}.${ext}"`,
                    'Content-Length': stats.size,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': 'Content-Disposition',
                });

                const stream = fs.createReadStream(tempFile);
                stream.pipe(res);

                stream.on('end', () => { fs.unlink(tempFile, () => { }); });
                stream.on('error', (err) => {
                    console.error('Stream error:', err);
                    fs.unlink(tempFile, () => { });
                });

                // ✅ FIX 1 resolved: req is now available
                req.on('close', () => { fs.unlink(tempFile, () => { }); });

            } catch (err) {
                fail(err);
            }
        });

    } catch (err) {
        fail(err);
    }
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
    }

    // ✅ FIX 1: pass `req` to handleDownload
    if (parsedUrl.pathname === '/api/download' && req.method === 'GET') {
        return handleDownload(parsedUrl, req, res);
    }

    if (parsedUrl.pathname === '/api/info' && req.method === 'GET') {
        const videoUrl = parsedUrl.searchParams.get('url');
        if (!videoUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            return res.end(JSON.stringify({ error: 'Missing url parameter' }));
        }

        const subprocess = spawn(YTDLP_BINARY, [
            videoUrl,
            '--no-playlist',
            '--dump-json',
            '--no-warnings',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ]);

        let stdoutBuffer = '';
        subprocess.stdout.on('data', chunk => { stdoutBuffer += chunk; });
        subprocess.stderr.on('data', () => { });

        // ✅ Timeout for info endpoint too
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
            } catch (e) { }

            // Fallback for blocked posts
            if (finalTitle === 'Video Download' || !finalTitle) {
                try {
                    const fallbackRes = await fetch(`https://api.microlink.io?url=${encodeURIComponent(videoUrl)}`);
                    if (fallbackRes.ok) {
                        const fallbackData = await fallbackRes.json();
                        if (fallbackData.data?.title) finalTitle = fallbackData.data.title;
                        if (fallbackData.data?.image?.url) finalThumbnail = fallbackData.data.image.url;
                    }
                } catch (fallbackErr) { }
            }

            res.end(JSON.stringify({ title: finalTitle, thumbnail: finalThumbnail, duration, formats }));
        });
        return;
    }

    // Health check endpoint
    if (parsedUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        return res.end(JSON.stringify({ status: 'ok', ytdlp: YTDLP_BINARY }));
    }

    // Static file serving (for local dev)
    let pathname = parsedUrl.pathname;
    if (pathname === '/') pathname = '/index.html';

    const filePath = path.join(PUBLIC_DIR, pathname);
    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Not found');
        }
        const stream = fs.createReadStream(filePath);
        res.writeHead(200, { 'Content-Type': getContentType(filePath) });
        stream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log(`yt-dlp binary: ${YTDLP_BINARY}`);
});
