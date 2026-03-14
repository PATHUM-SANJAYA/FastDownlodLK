const { spawn } = require('child_process');
const path = require('path');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
const TEST_URL = 'https://www.youtube.com/watch?v=77N1DTEsuxk';

async function testNoCookieAndroid() {
    console.log('--- Testing NO-COOKIE Android Bypass ---');
    console.log(`URL: ${TEST_URL}`);
    
    // Test Android client without cookies
    const args = [
        '--extractor-args', 'youtube:player-client=android',
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
            console.log('\n✅ NO-COOKIE SUCCESS: Android client worked!');
        } else {
            console.error(`\n❌ NO-COOKIE FAILED: Exit code ${code}`);
        }
    });
}

testNoCookieAndroid();
