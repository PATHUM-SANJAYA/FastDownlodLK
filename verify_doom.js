const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const YTDLP_BINARY = path.join(__dirname, 'node_modules', 'youtube-dl-exec', 'bin', 'yt-dlp.exe');
const PO_TOKEN = fs.readFileSync(path.join(__dirname, 'po_token.txt'), 'utf8').trim();
const VISITOR_DATA = fs.readFileSync(path.join(__dirname, 'visitor_data.txt'), 'utf8').trim();

const TEST_URLS = [
    'https://www.youtube.com/watch?v=QIUu0qeHY1w',
    'https://www.youtube.com/watch?v=lZ_eRLfUfL4'
];

async function runTest(url) {
    console.log(`\n--- Testing Doom Tool for: ${url} ---`);
    
    const args = [
        '--extractor-args', `youtube:po_token=web.gvs+${PO_TOKEN};visitor_data=${VISITOR_DATA}`,
        '--get-title',
        '--get-format',
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

(async () => {
    for (const url of TEST_URLS) {
        await runTest(url);
    }
})();
