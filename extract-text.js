const fs = require('fs');
const path = require('path');

// 1. Define the files you want to scan (update paths if needed)
const filesToScan = [
  'app/src/pages/gamepad-popup.html',
  'app/src/pages/setup.html',
  'app/src/pages/index.html',
  'app/src/pages/host.html',
  'app/src/pages/dashboard.html',
  // Upstream renamed this string to nearcade-arcade.html but the file itself
  // is still nearsec-arcade.html in the tree — reference the real file.
  'website/nearsec-arcade.html',
  'app/src/scripts/audio-util.js',
  'app/src/scripts/server.js',
  'app/src/scripts/host.js',
  'app/src/scripts/viewer.js',
  'website/arcade.js',
];

const dictionary = {};

// Helper to clean up strings and generate a safe JSON key
function addEntry(text, prefix = 'txt') {
  // Remove HTML entities, extra spaces, and newlines
  const cleanText = text
    .replace(/&[a-z]+;/g, '')
    .trim()
    .replace(/\s+/g, ' ');

  // Ignore empty strings, single characters, pure numbers, or pure symbols
  if (cleanText.length < 2 || /^[0-9\W]+$/.test(cleanText)) return;

  // Generate a key based on the first few words
  const keyBase = cleanText
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 35)
    .replace(/_$/, '');
  const key = `${prefix}_${keyBase}`;

  // Add to dictionary if it doesn't exist
  if (!dictionary[key]) {
    dictionary[key] = cleanText;
  }
}

// 2. The Extraction Logic
filesToScan.forEach((filePath) => {
  const fullPath = path.join(__dirname, filePath);
  if (!fs.existsSync(fullPath)) {
    console.log(`⚠  Skipping ${filePath} (File not found)`);
    return;
  }

  const content = fs.readFileSync(fullPath, 'utf8');

  if (filePath.endsWith('.html')) {
    // Extract text between HTML tags: > Text Here <
    const htmlWithoutScripts = content.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
    const tagMatches = htmlWithoutScripts.matchAll(/>([^<]+)</g);
    for (const match of tagMatches) {
      addEntry(match[1], 'ui');
    }

    // Extract placeholder attributes
    const placeholderMatches = content.matchAll(/placeholder=["']([^"']+)["']/g);
    for (const match of placeholderMatches) {
      addEntry(match[1], 'ph');
    }

    // Extract title attributes (tooltips)
    const titleMatches = content.matchAll(/title=["']([^"']+)["']/g);
    for (const match of titleMatches) {
      addEntry(match[1], 'title');
    }
  } else if (filePath.endsWith('.js')) {
    // 1. Standard UI functions + Explicit I18N.t() wrapper
    // Catches: log('..'), sysChat('..'), I18N.t('..') using quotes OR backticks
    const funcMatches = content.matchAll(/(?:log|sysChat|setStatus|showTunnelError|I18N\.t)\s*\(\s*['"`](.*?)['"`]/g);
    for (const match of funcMatches) {
      addEntry(match[1], 'msg');
    }

    // 2. textContent OR innerHTML assignments
    const domMatches = content.matchAll(/\.(?:textContent|innerHTML)\s*=\s*['"`](.*?)['"`]/g);
    for (const match of domMatches) {
      let rawText = match[1];
      // If it's innerHTML, strip the HTML tags so we only extract the raw text
      if (rawText.includes('<')) {
        rawText = rawText.replace(/<[^>]*>?/gm, ' ');
      }
      addEntry(rawText, 'ui');
    }

    // 3. appendChat('Name', 'Text')
    const chatMatches = content.matchAll(/appendChat\([^,]+,\s*['"`](.*?)['"`]/g);
    for (const match of chatMatches) {
      addEntry(match[1], 'msg');
    }
  }
});

// 3. Save the Dictionary
const outputDir = path.join(__dirname, 'assets', 'locales');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const outputPath = path.join(outputDir, 'en.json');
fs.writeFileSync(outputPath, JSON.stringify(dictionary, null, 2));

console.log(`\n Extraction complete! Found ${Object.keys(dictionary).length} unique strings.`);
console.log(` Saved dictionary to: ${outputPath}\n`);
