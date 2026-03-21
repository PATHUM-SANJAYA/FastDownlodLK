const { spawn } = require('child_process');
const path = require('path');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');

const TEST_URLS = [
    'https://www.facebook.com/share/r/19jqoXoQyv/'
];

async function runTest(url) {
    console.log(`\n--- Testing Facebook Doom Tool WITHOUT Cookies: ${url} ---`);
    
    // Exact same as verify_fb_nocookie.js, tailored for the user's new URL
    const args = [
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
