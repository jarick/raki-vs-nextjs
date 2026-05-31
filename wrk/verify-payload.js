// wrk/verify-payload.js
// Structural comparison of RSC payloads from Rari and Next.js

const http = require('http');

async function fetchPayload(host) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}/`, { timeout: 10000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          contentType: res.headers['content-type'],
          contentLength: parseInt(res.headers['content-length'] || body.length),
          raw: body,
        });
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function analyzeRSCPayload(raw) {
  // RSC wire format is a stream of tagged chunks
  // Each chunk starts with a tag-byte followed by JSON
  const text = raw.toString('utf8');
  const lines = text.split('\n').filter(l => l.length > 0);
  const chunks = [];
  for (const line of lines) {
    if (line.length > 0) {
      const tag = line[0];
      const rest = line.slice(1);
      try {
        const parsed = JSON.parse(rest);
        chunks.push({ tag, data: parsed });
      } catch {
        chunks.push({ tag, raw: rest.slice(0, 100) });
      }
    }
  }
  return {
    totalBytes: raw.length,
    numChunks: chunks.length,
    chunkTags: chunks.map(c => c.tag).join(''),
    chunks,
  };
}

function extractComponentTree(chunks) {
  // RSC elements have structure like:
  // { type: 'Element', element: ['ComponentName', { props }, children] }
  const components = [];
  for (const chunk of chunks) {
    if (chunk.tag === 'J' && chunk.data?.type === 'Element') {
      const el = chunk.data.element;
      if (Array.isArray(el) && el.length >= 1) {
        components.push(el[0]); // component name
      }
    }
  }
  return components;
}

async function main() {
  const targets = [
    { name: 'rari-app', host: 'rari-app:3000' },
    { name: 'next-app', host: 'next-app:3000' },
  ];

  const results = {};
  for (const { name, host } of targets) {
    const payload = await fetchPayload(host);
    const analysis = analyzeRSCPayload(payload.raw);
    const tree = extractComponentTree(analysis.chunks);

    results[name] = {
      statusCode: payload.statusCode,
      contentType: payload.contentType,
      contentLength: payload.contentLength,
      numChunks: analysis.numChunks,
      componentTree: tree,
      allChunkTags: analysis.chunkTags,
    };
    console.log(`\n=== ${name} ===`);
    console.log(`Status: ${payload.statusCode}`);
    console.log(`Content-Type: ${payload.contentType}`);
    console.log(`Content-Length: ${payload.contentLength}`);
    console.log(`RSC Chunks: ${analysis.numChunks}`);
    console.log(`Chunk Tags: ${analysis.chunkTags}`);
    console.log(`Component Tree: ${JSON.stringify(tree)}`);
  }

  // Structural comparison
  const r = results['rari-app'];
  const n = results['next-app'];

  console.log('\n=== STRUCTURAL COMPARISON ===');
  const structuralMatch =
    r.contentType === n.contentType &&
    r.componentTree.length === n.componentTree.length &&
    r.componentTree.every((c, i) => c === n.componentTree[i]);

  if (structuralMatch) {
    console.log('✓ Component tree: IDENTICAL');
    console.log(`✓ Both serve ${r.contentType}`);
    console.log(`✓ Components: ${r.componentTree.join(' → ')}`);
    console.log(`ℹ Size difference: ${Math.abs(r.contentLength - n.contentLength)} bytes`);
    process.exit(0);
  } else {
    console.log('✗ Component tree: DIFFERS');
    console.log(`  Rari:  ${JSON.stringify(r.componentTree)}`);
    console.log(`  Next:  ${JSON.stringify(n.componentTree)}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
