const url = 'https://www.tiktok.com/@mrbeast/video/7257993077673528619';

async function testMicrolink() {
    try {
        const res = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`);
        const json = await res.json();
        console.log('Microlink:', json.data.title, json.data.image?.url);
    } catch (e) {
        console.error('microlink fail', e.message);
    }
}

async function testFetch() {
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || html.match(/<meta property="og:title" content="([^"]+)"/i);
        const imageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);
        console.log('Fetch:', titleMatch?.[1]?.trim(), imageMatch?.[1]);
    } catch (e) {
        console.error('fetch fail', e.message);
    }
}

testMicrolink();
testFetch();
