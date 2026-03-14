const { spawn } = require('child_process');
const path = require('path');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
const TEST_URL = 'https://www.youtube.com/watch?v=77N1DTEsuxk';

async function testTVBypass() {
    console.log('--- Testing TV_EMBEDDED Bypass ---');
    console.log(`URL: ${TEST_URL}`);
    
    const args = [
        '--extractor-args', 'youtube:player-client=tv_embedded',
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
            console.log('\n✅ TV_EMBEDDED SUCCESS!');
        } else {
            console.error(`\n❌ TV_EMBEDDED FAILED: Exit code ${code}`);
        }
    });
}

testTVBypass();
