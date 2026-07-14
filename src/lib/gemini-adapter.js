import { fileURLToPath } from 'node:url';
import path from 'node:path';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--version')) {
    console.log('gemini-adapter 1.1.1 (via Google API)');
    process.exit(0);
  }
  
  let prompt = '';
  let accessMode = 'read-only';
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && i + 1 < args.length) {
      prompt = args[i + 1];
      i++;
    } else if (args[i] === '--access-mode' && i + 1 < args.length) {
      accessMode = args[i + 1];
      i++;
    }
  }
  
  if (!prompt) {
    console.error(JSON.stringify({ type: 'error', error: 'Prompt is required' }));
    process.exit(1);
  }
  
  if (!GOOGLE_API_KEY) {
    console.error(JSON.stringify({ type: 'error', error: 'GOOGLE_API_KEY environment variable is not set' }));
    process.exit(1);
  }
  
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?key=${GOOGLE_API_KEY}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    
    if (!response.ok) {
      const errText = await response.text();
      console.error(JSON.stringify({ type: 'error', error: `Gemini API returned status ${response.status}: ${errText}` }));
      process.exit(1);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulatedText = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      
      let pos;
      while ((pos = findJsonObjectBoundary(buffer)) !== -1) {
        let chunkStr = buffer.slice(0, pos).trim();
        buffer = buffer.slice(pos);
        
        if (chunkStr.startsWith('[')) {
          chunkStr = chunkStr.slice(1).trim();
        }
        if (chunkStr.startsWith(',')) {
          chunkStr = chunkStr.slice(1).trim();
        }
        if (chunkStr.endsWith(']')) {
          chunkStr = chunkStr.slice(0, -1).trim();
        }
        
        if (chunkStr) {
          try {
            const parsed = JSON.parse(chunkStr);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              accumulatedText += text;
              console.log(JSON.stringify({
                type: 'message',
                role: 'assistant',
                content: text
              }));
            }
          } catch (e) {
            // Ignore incomplete chunks
          }
        }
      }
    }
    
    // Output final result event
    console.log(JSON.stringify({
      type: 'result',
      result: accumulatedText
    }));
    
  } catch (error) {
    console.error(JSON.stringify({ type: 'error', error: error.message }));
    process.exit(1);
  }
}

function findJsonObjectBoundary(str) {
  let braceCount = 0;
  let inString = false;
  let escape = false;
  
  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    
    if (escape) {
      escape = false;
      continue;
    }
    
    if (char === '\\') {
      escape = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{') {
        braceCount++;
      } else if (char === '}') {
        braceCount--;
        if (braceCount === 0) {
          return i + 1;
        }
      }
    }
  }
  return -1;
}

main();
