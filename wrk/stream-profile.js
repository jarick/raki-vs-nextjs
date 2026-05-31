const http = require('http')
const fs = require('fs')

const TARGETS = process.argv.slice(2)
if (TARGETS.length === 0) {
  console.error('Usage: node stream-profile.js <target> [target...]')
  console.error('Example: node stream-profile.js rari-app:3000 next-app:3000')
  process.exit(1)
}

const RUNS = 5
const TIMEOUT_MS = 15000
const OUTPUT_PATH = '/results/streaming-results.json'

async function profileTarget(target) {
  const results = []

  for (let run = 1; run <= RUNS; run++) {
    const start = Date.now()
    let error = null

    try {
      const result = await new Promise((resolve, reject) => {
        const req = http.get(
          `http://${target}/stream`,
          { timeout: TIMEOUT_MS },
          (res) => {
            const chunks = []
            let totalBytes = 0
            let index = 0

            if (res.statusCode !== 200) {
              res.resume()
              reject(new Error(`HTTP ${res.statusCode}`))
              return
            }

            res.on('data', (chunk) => {
              const now = Date.now() - start
              chunks.push({
                index,
                ms: now,
                bytes: chunk.length,
                cumulativeBytes: totalBytes,
              })
              totalBytes += chunk.length
              index++
            })

            res.on('end', () => {
              if (chunks.length === 0) {
                reject(new Error('No chunks received'))
                return
              }

              const ttfb = chunks[0].ms
              const lastByte = chunks[chunks.length - 1].ms

              const gaps = []
              for (let i = 1; i < chunks.length; i++) {
                gaps.push(chunks[i].ms - chunks[i - 1].ms)
              }

              const sorted = [...gaps].sort((a, b) => a - b)
              const gapMean = gaps.length > 0
                ? gaps.reduce((a, b) => a + b, 0) / gaps.length
                : 0
              const gapP50 = sorted.length > 0
                ? sorted[Math.floor(sorted.length * 0.5)]
                : 0
              const gapP95 = sorted.length > 0
                ? sorted[Math.floor(sorted.length * 0.95)]
                : 0
              const gapMax = sorted.length > 0
                ? sorted[sorted.length - 1]
                : 0

              const skeletonBytes = chunks[0].bytes
              const skeletonThreshold = skeletonBytes + 512
              const firstContent = chunks.find(c => c.bytes > skeletonThreshold)

              const checkpoints = [500, 1000, 2000, 5000]
              const progressiveBytes = {}
              for (const cp of checkpoints) {
                const cpChunks = chunks.filter(c => c.ms <= cp)
                progressiveBytes[`${cp}ms`] = cpChunks.reduce(
                  (a, c) => a + c.bytes, 0
                )
              }

              resolve({
                ttfb_ms: ttfb,
                firstContentChunk_ms: firstContent ? firstContent.ms : null,
                lastByte_ms: lastByte,
                chunks: chunks.length,
                interChunkGap_ms: {
                  mean: Math.round(gapMean * 100) / 100,
                  p50: gapP50,
                  p95: gapP95,
                  max: gapMax,
                },
                skeletonDuration_ms: lastByte - ttfb,
                progressiveBytes,
                error: null,
              })
            })
          }
        )

        req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)))
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
      })

      results.push(result)
      process.stderr.write(
        `  Run ${run}/${RUNS}: ttfb=${result.ttfb_ms}ms lastByte=${result.lastByte_ms}ms chunks=${result.chunks}\n`
      )
    } catch (e) {
      process.stderr.write(`  Run ${run}/${RUNS}: ERROR ${e.message}\n`)
      results.push({
        ttfb_ms: null, firstContentChunk_ms: null, lastByte_ms: null,
        chunks: null, interChunkGap_ms: null, skeletonDuration_ms: null,
        progressiveBytes: null, error: e.message,
      })
    }
  }

  const valid = results.filter(r => !r.error && r.ttfb_ms !== null)
  if (valid.length === 0) {
    return { target, runs: RUNS, successful: 0, error: 'All runs failed' }
  }

  function median(arr) {
    const s = [...arr].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  return {
    target,
    runs: RUNS,
    successful: valid.length,
    profile: {
      ttfb_ms: median(valid.map(r => r.ttfb_ms)),
      firstContentChunk_ms: median(valid.map(r => r.firstContentChunk_ms).filter(Boolean)),
      lastByte_ms: median(valid.map(r => r.lastByte_ms)),
      chunks: median(valid.map(r => r.chunks)),
      interChunkGap_ms: {
        mean: Math.round(median(valid.map(r => r.interChunkGap_ms.mean)) * 100) / 100,
        p50: median(valid.map(r => r.interChunkGap_ms.p50)),
        p95: median(valid.map(r => r.interChunkGap_ms.p95)),
        max: median(valid.map(r => r.interChunkGap_ms.max)),
      },
      skeletonDuration_ms: median(valid.map(r => r.skeletonDuration_ms)),
      progressiveBytes: {
        '500ms': Math.round(median(valid.map(r => r.progressiveBytes['500ms']))),
        '1000ms': Math.round(median(valid.map(r => r.progressiveBytes['1000ms']))),
        '2000ms': Math.round(median(valid.map(r => r.progressiveBytes['2000ms']))),
        '5000ms': Math.round(median(valid.map(r => r.progressiveBytes['5000ms']))),
      },
    },
  }
}

async function main() {
  const allResults = []
  for (const target of TARGETS) {
    process.stderr.write(`\nProfiling ${target}...\n`)
    const result = await profileTarget(target)
    allResults.push(result)

    console.log(`\n--- ${target} ---`)
    if (result.error) {
      console.log(`  ERROR: ${result.error}`)
      continue
    }
    console.log(`  Runs: ${result.successful}/${result.runs}`)
    console.log(`  TTFB: ${result.profile.ttfb_ms}ms`)
    console.log(`  First content chunk: ${result.profile.firstContentChunk_ms}ms`)
    console.log(`  Last byte: ${result.profile.lastByte_ms}ms`)
    console.log(`  Chunks: ${result.profile.chunks}`)
    console.log(`  Inter-chunk gap (mean/p50/p95/max): ${
      result.profile.interChunkGap_ms.mean
    }/${result.profile.interChunkGap_ms.p50}/${
      result.profile.interChunkGap_ms.p95
    }/${result.profile.interChunkGap_ms.max}ms`)
    console.log(`  Skeleton duration: ${result.profile.skeletonDuration_ms}ms`)
    console.log(`  Progressive bytes: 500ms=${result.profile.progressiveBytes['500ms']}B 1000ms=${result.profile.progressiveBytes['1000ms']}B 2000ms=${result.profile.progressiveBytes['2000ms']}B 5000ms=${result.profile.progressiveBytes['5000ms']}B`)
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allResults, null, 2))
  process.stderr.write(`\nResults saved to ${OUTPUT_PATH}\n`)
}

main().catch(console.error)
