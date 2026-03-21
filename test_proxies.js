const { spawnSync } = require('child_process');
const fs = require('fs');

const YTDLP = '/tmp/yt-dlp';
const PROXIES = [
    'socks5://171.250.217.94:1080',
    'socks5://8.211.195.139:1080',
    'socks5://90.189.149.244:1080',
    'socks5://202.162.219.10:1080',
    'socks5://103.189.218.158:1080',
    'socks5://194.124.211.132:1080'
];

async function test() {
    console.log(`Checking yt-dlp at: ${YTDLP}`);
    if (!fs.existsSync(YTDLP)) {
        console.error('yt-dlp NOT FOUND in /tmp! Trying which yt-dlp...');
        const which = spawnSync('which', ['yt-dlp'], { encoding: 'utf8' });
        if (which.status === 0) {
            console.log(`Found via which: ${which.stdout.trim()}`);
            runTests(which.stdout.trim());
        } else {
            console.error('yt-dlp not found anywhere.');
            process.exit(1);
        }
    } else {
        runTests(YTDLP);
    }
}

function runTests(binary) {
    for (const proxy of PROXIES) {
        console.log(`Testing: ${proxy}`);
        try {
            const result = spawnSync(binary, [
                '--proxy', proxy,
                '--force-ipv4',
                '--socket-timeout', '10',
                '-e', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
            ], { encoding: 'utf8' });

            if (result.status === 0) {
                console.log(`[SUCCESS] Proxy works! Title: ${result.stdout.trim()}`);
                process.exit(0);
            } else {
                const err = result.stderr || result.error?.message || 'Unknown error';
                console.log(`[FAILED] Error: ${err.slice(0, 100)}`);
            }
        } catch (e) {
            console.log(`[FAILED] Exception: ${e.message}`);
        }
    }
    console.log('No proxies worked.');
}

test();
