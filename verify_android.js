const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const TEST_URL = 'https://www.youtube.com/watch?v=77N1DTEsuxk';

async function testAndroidBypass() {
    console.log('--- Testing Android-First Bypass ---');
    console.log(`URL: ${TEST_URL}`);
    
    // We simulate the logic in server.js: prioritizing android player client
    const args = [
        '--cookies', COOKIES_PATH,
        '--extractor-args', 'youtube:player-client=android,ios,web',
        '--get-title',
        '--get-format',
        TEST_URL
    ];

    console.log(`Executing: yt-dlp ${args.join(' ')}`);

    const child = spawn(YTDLP_BINARY, args);

    child.stdout.on('data', (data) => console.log(`STDOUT: ${data}`));
    child.stderr.on('data', (data) => console.error(`STDERR: ${data}`));

    child.on('close', (code) => {
        if (code === 0) {
            console.log('\n✅ VERIFICATION SUCCESSFUL: Android client bypass worked!');
        } else {
            console.error(`\n❌ VERIFICATION FAILED: Exit code ${code}`);
        }
    });
}

testAndroidBypass();
