const { generate } = require('youtube-po-token-generator');
const fs = require('fs');
const path = require('path');

async function runGenerator() {
    console.log('Generating PO Token and Visitor Data...');
    try {
        const result = await generate();
        console.log('Generation successful!');
        console.log(JSON.stringify(result, null, 2));

        // Save to files for the server to use
        fs.writeFileSync(path.join(__dirname, 'po_token.txt'), result.poToken);
        fs.writeFileSync(path.join(__dirname, 'visitor_data.txt'), result.visitorData);
        
        console.log('\nSuccess! Files saved: po_token.txt, visitor_data.txt');
    } catch (error) {
        console.error('Error generating token:', error);
        process.exit(1);
    }
}

runGenerator();
