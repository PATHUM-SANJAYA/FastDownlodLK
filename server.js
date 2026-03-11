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
const YTDLP_PATH = path.join(os.tmpdir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

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
                    if (process.platform !== 'win32') {
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
        } catch (_) {
            console.log(`Cached binary at ${YTDLP_PATH} failed to execute. Deleting it.`);
            try { fs.unlinkSync(YTDLP_PATH); } catch (e) { }
        }
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

    // Choose correct binary based on OS
    const downloadUrl = process.platform === 'linux'
        ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux'
        : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

    await downloadFile(downloadUrl, YTDLP_PATH);
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
    const ext = isAudio ? 'mp3' : 'mp4';

    const tempId = Math.random().toString(36).substring(2, 10);
    const tempFileTemplate = path.join(os.tmpdir(), `dl_${tempId}.%(ext)s`);

    // Let yt-dlp auto-negotiate the best client
    const GENERAL_BYPASS = [
        '--no-cache-dir',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        '--impersonate-client', 'chrome'
    ];

    // Direct streaming arguments
    const args = isAudio
        ? [
            videoUrl, '--no-playlist',
            '-x', '--audio-format', 'mp3', '--audio-quality', '5',
            '-o', tempFileTemplate,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings', '--quiet',
            ...GENERAL_BYPASS
        ]
        : [
            videoUrl, '--no-playlist',
            // Get best video + audio that matches the requested max height, or best single format
            '-f', `bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]/best`,
            '--merge-output-format', 'mp4', // Try to merge to mp4 if possible
            '-o', tempFileTemplate,
            '--ffmpeg-location', ffmpegPath,
            '--no-warnings', '--quiet',
            ...GENERAL_BYPASS
        ];

    let finished = false;
    let subprocess = null;

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
        console.error('Download error:', err?.message || err);
        
        // Try to clean up any file starting with this tempId
        try {
            const dirFiles = fs.readdirSync(os.tmpdir());
            const file = dirFiles.find(f => f.startsWith(`dl_${tempId}.`));
            if (file) fs.unlink(path.join(os.tmpdir(), file), () => {});
        } catch (e) {}

        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ status: 'error', message: 'Download failed.' }));
        } else {
            try { res.end(); } catch (_) { }
        }
    };

    req.on('close', () => {
        if (subprocess && !finished) {
            subprocess.kill('SIGKILL');
        }
        finished = true;
        clearTimeout(timeout);
    });

    try {
        // Ensure node is in PATH so yt-dlp can solve JS challenges
        const env = Object.assign({}, process.env);
        env.PATH = path.dirname(process.execPath) + (process.platform === 'win32' ? ';' : ':') + (env.PATH || '');

        // We write to a temp file, so we MUST ignore stdout. If we leave it as 'pipe' and don't read it, the buffer fills and process hangs!
        subprocess = spawn(YTDLP_BINARY, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
        let stderrBuffer = '';
        subprocess.stderr.on('data', d => { stderrBuffer += d.toString(); });

        subprocess.on('error', fail);
        subprocess.on('close', (code) => {
            if (finished) return;
            finished = true;
            clearTimeout(timeout);

            // Find the actual output file generated
            let tempFile = null;
            try {
                const dirFiles = fs.readdirSync(os.tmpdir());
                const matchingFile = dirFiles.find(f => f.startsWith(`dl_${tempId}.`));
                if (matchingFile) {
                    tempFile = path.join(os.tmpdir(), matchingFile);
                }
            } catch (e) {}

            if (code !== 0 || !tempFile || !fs.existsSync(tempFile)) {
                return fail(new Error(`yt-dlp exited with code ${code}. Stderr: ${stderrBuffer}`));
            }
            try {
                const stats = fs.statSync(tempFile);
                if (stats.size < 1000) throw new Error('File too small — likely blocked.');
                
                const actualExt = path.extname(tempFile).substring(1);
                let contentType = 'video/mp4';
                if (actualExt === 'mp3') contentType = 'audio/mpeg';
                else if (actualExt === 'webm') contentType = 'video/webm';
                else if (actualExt === 'mkv') contentType = 'video/x-matroska';
                
                res.writeHead(200, {
                    'Content-Type': contentType,
                    'Content-Disposition': `attachment; filename="${safeTitle}.${actualExt}"`,
                    'Content-Length': stats.size,
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
                });
                const stream = fs.createReadStream(tempFile);
                stream.pipe(res);
                stream.on('end', () => fs.unlink(tempFile, () => { }));
                stream.on('error', (e) => { fs.unlink(tempFile, () => { }); });
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
                '--ffmpeg-location', ffmpegPath,
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

            const subprocess = spawn(YTDLP_BINARY, [
                videoUrl, '--no-playlist', '--dump-json', '--no-warnings', '--no-cache-dir',
                '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                '--impersonate-client', 'chrome'
            ], { env });

            let stdoutBuffer = '';
            subprocess.stdout.on('data', c => stdoutBuffer += c);
            subprocess.stderr.on('data', () => { });
            const infoTimeout = setTimeout(() => subprocess.kill('SIGKILL'), 30000);

            // Close subprocess tightly if client drops connection
            req.on('close', () => {
                if (subprocess.exitCode === null) {
                    subprocess.kill('SIGKILL');
                }
            });

            subprocess.on('error', () => {
                if (subprocess.exitCode === null) subprocess.kill('SIGKILL');
            });

            subprocess.on('close', async () => {
                clearTimeout(infoTimeout);
                if (res.headersSent) return;
                
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
