const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');

const TEST_URLS = [
    'https://www.facebook.com/facebook/videos/10153231379946729/'
];

async function runTest(url) {
    console.log(`\n--- Testing Facebook with Global Cookies: ${url} ---`);
    
    const args = [
        '--cookies', COOKIES_PATH,
        '--get-title',
        '--get-format',
        '--verbose',
        url
    ];

    console.log(`Executing: yt-dlp ${args.join(' ')}`);

    return new Promise((resolve) => {
        const child = spawn(YTDLP_BINARY, args);
        let output = '';

        child.stdout.on('data', (data) => {
            output += data;
            console.log(`STDOUT: ${data}`);
        });
        child.stderr.on('data', (data) => console.error(`STDERR: ${data}`));

        child.on('close', (code) => {
            if (code === 0) {
                console.log(`✅ SUCCESS: ${url}`);
                resolve(true);
            } else {
                console.error(`\n❌ FAILED: ${url} (Exit code ${code})`);
                resolve(false);
            }
        });
    });
}

runTest(TEST_URLS[0]);
