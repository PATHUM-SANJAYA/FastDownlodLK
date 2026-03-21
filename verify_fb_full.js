const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
let FFMPEG_BINARY;
try {
    const ffmpegPath = require('ffmpeg-static');
    if (ffmpegPath) {
        execSync(`"${ffmpegPath}" -version`, { stdio: 'ignore' });
        FFMPEG_BINARY = ffmpegPath;
    }
} catch (e) {
    FFMPEG_BINARY = 'ffmpeg';
}

const TEST_URL = 'https://www.facebook.com/share/r/19jqoXoQyv/';

const GENERAL_BYPASS = [
    '--no-cache-dir',
    '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    '--force-ipv4',
    '--socket-timeout', '60',
    '--js-runtimes', `node:${process.execPath}`,
    '--geo-bypass',
    '--no-check-certificate'
];

const tempFile = path.join(os.tmpdir(), `test_dl_${Date.now()}.mp4`);

const args = [
    TEST_URL, '--no-playlist',
    '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '--merge-output-format', 'mp4',
    '-o', tempFile,
    '--ffmpeg-location', FFMPEG_BINARY,
    '--no-warnings',
    ...GENERAL_BYPASS
];

console.log(`\n--- Running FULL DOWNLOAD Test on Facebook ---`);
console.log(`Executing: yt-dlp ${args.join(' ')}\n`);

const child = spawn(YTDLP_BINARY, args);

child.stdout.on('data', d => process.stdout.write(d));
child.stderr.on('data', d => process.stderr.write(d));

child.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempFile)) {
        const stats = fs.statSync(tempFile);
        console.log(`\n✅ SUCCESS! Downloaded file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`File saved at: ${tempFile}`);
    } else {
        console.error(`\n❌ FAILED. Exit code: ${code}`);
    }
});
