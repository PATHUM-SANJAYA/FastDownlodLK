const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { URL } = require('url');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 8002;
const PUBLIC_DIR = __dirname;
const YTDLP_BINARY = path.join(
    __dirname,
    'node_modules',
    'youtube-dl-exec',
    'bin',
    process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
);

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

async function handleDownload(parsedUrl, res) {
    const videoUrl = parsedUrl.searchParams.get('url');
    const quality = parsedUrl.searchParams.get('quality') || '720';
    const type = parsedUrl.searchParams.get('type') || 'video';
    const rawTitle = parsedUrl.searchParams.get('title') || 'download';

    // Sanitize title to prevent header injection or filesystem errors
    const safeTitle = rawTitle.replace(/[^a-z0-9 -]/gi, '_').substring(0, 150);

    if (!videoUrl) {
        res.writeHead(400, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
        });
        return res.end(JSON.stringify({
            status: 'error',
            message: 'Missing url parameter.',
        }));
    }

    const isAudio = type === 'audio' || quality === 'audio';
    const tempId = Math.random().toString(36).substring(2, 10);
    const ext = isAudio ? 'mp3' : 'mp4';
    const tempFile = path.join(os.tmpdir(), `dl_${tempId}.${ext}`);

    // Stream to temp file instead of stdout so ffmpeg can properly mux mp4
    const args = isAudio
        ? [
            videoUrl,
            '--no-playlist',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '5',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--quiet',
            '--no-warnings',
        ]
        : [
            videoUrl,
            '--no-playlist',
            '-f', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/b[height<=${quality}][ext=mp4]/w`,
            '--merge-output-format', 'mp4',
            '-o', tempFile,
            '--ffmpeg-location', ffmpegPath,
            '--quiet',
            '--no-warnings',
        ];

    let finished = false;

    const fail = (err) => {
        if (finished) return;
        finished = true;

        console.error('yt-dlp failed:', err);

        if (fs.existsSync(tempFile)) fs.unlink(tempFile, () => { });

        if (!res.headersSent) {
            res.writeHead(500, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
            });
            res.end(JSON.stringify({
                status: 'error',
                message: 'Download failed. The video might be private, region-locked, or downloading was blocked by YouTube bot-protection.',
            }));
        } else {
            try { res.end(); } catch (_) { }
        }
    };

    try {
        const subprocess = spawn(YTDLP_BINARY, args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

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

            if (code !== 0 || !fs.existsSync(tempFile)) {
                const err = new Error(stderrBuffer || `yt-dlp exited with code ${code}`);
                fail(err);
                return;
            }

            try {
                const stats = fs.statSync(tempFile);
                if (stats.size < 1000) {
                    throw new Error('File too small, possibly blocked by bot protection.');
                }

                res.writeHead(200, {
                    'Content-Type': isAudio ? 'audio/mpeg' : 'video/mp4',
                    'Content-Disposition': `attachment; filename="${safeTitle}.${ext}"`,
                    'Content-Length': stats.size,
                    'Access-Control-Allow-Origin': '*',
                });

                const stream = fs.createReadStream(tempFile);
                stream.pipe(res);

                stream.on('end', () => {
                    fs.unlink(tempFile, () => { });
                });

                stream.on('error', (err) => {
                    console.error('Stream error:', err);
                    fs.unlink(tempFile, () => { });
                });

                req.on('close', () => {
                    fs.unlink(tempFile, () => { });
                });
            } catch (err) {
                fail(err);
            }
        });

        if (typeof subprocess.catch === 'function') {
            subprocess.catch(fail);
        }
    } catch (err) {
        fail(err);
    }
}

const server = http.createServer((req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        });
        return res.end();
    }

    if (parsedUrl.pathname === '/api/download' && req.method === 'GET') {
        return handleDownload(parsedUrl, res);
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
            '--no-warnings'
        ]);

        let stdoutBuffer = '';
        subprocess.stdout.on('data', chunk => { stdoutBuffer += chunk; });
        subprocess.stderr.on('data', () => { }); // Consume stderr to prevent hangs

        subprocess.on('close', async () => {
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
            } catch (e) {
                // JSON parse fails if yt-dlp was completely blocked
            }

            // Fallback for blocked posts (TikTok, Instagram)
            if (finalTitle === 'Video Download' || !finalTitle) {
                try {
                    const fallbackRes = await fetch(`https://api.microlink.io?url=${encodeURIComponent(videoUrl)}`);
                    if (fallbackRes.ok) {
                        const fallbackData = await fallbackRes.json();
                        if (fallbackData.data?.title) finalTitle = fallbackData.data.title;
                        if (fallbackData.data?.image?.url) finalThumbnail = fallbackData.data.image.url;
                    }
                } catch (fallbackErr) {
                    console.error('Microlink fallback failed:', fallbackErr);
                }
            }

            res.end(JSON.stringify({
                title: finalTitle,
                thumbnail: finalThumbnail,
                duration: duration,
                formats: formats
            }));
        });
        return;
    }

    // Static file serving
    let pathname = parsedUrl.pathname;
    if (pathname === '/') {
        pathname = '/index.html';
    }

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
});

