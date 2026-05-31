const http = require('http')
const fs = require('fs')

const TARGETS = process.argv.slice(2)
if (TARGETS.length === 0) {
  console.error('Usage: node fetch-profile.js <target> [target...]')
  process.exit(1)
}

const RUNS = 10
const TIMEOUT_MS = 10000
const OUTPUT_PATH = '/results/fetch-results.json'

function extractFetchDuration(raw) {
  const text = raw.toString('utf8')
  const match = text.match(/(\d+)ms<\/td>/)
  if (match) return parseInt(match[1], 10)
  return null
}

async function profileTarget(target) {
  const durations = []

  for (let run = 1; run <= RUNS; run++) {
    try {
      const { body, statusCode } = await new Promise((resolve, reject) => {
        const req = http.get(
          `http://${target}/fetch`,
          { timeout: TIMEOUT_MS },
          (res) => {
            const chunks = []
            res.on('data', (c) => chunks.push(c))
            res.on('end', () => {
              resolve({
                body: Buffer.concat(chunks),
                statusCode: res.statusCode,
              })
            })
            res.on('error', reject)
          }
        )
        req.on('error', (e) => reject(new Error(`Request failed: ${e.message}`)))
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
      })

      if (statusCode !== 200) {
        process.stderr.write(`  Run ${run}/${RUNS}: HTTP ${statusCode}\n`)
        continue
      }

      const duration = extractFetchDuration(body)
      if (duration === null) {
        process.stderr.write(`  Run ${run}/${RUNS}: Could not extract fetch duration from response\n`)
        continue
      }

      durations.push(duration)
      process.stderr.write(`  Run ${run}/${RUNS}: fetch=${duration}ms\n`)
    } catch (e) {
      process.stderr.write(`  Run ${run}/${RUNS}: ERROR ${e.message}\n`)
    }
  }

  if (durations.length === 0) {
    return { target, runs: RUNS, successful: 0, error: 'All runs failed' }
  }

  const sorted = [...durations].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const mean = durations.reduce((a, b) => a + b, 0) / durations.length
  const min = Math.min(...durations)
  const max = Math.max(...durations)

  return {
    target,
    runs: RUNS,
    successful: durations.length,
    fetchDuration_ms: {
      min,
      median,
      mean: Math.round(mean * 100) / 100,
      max,
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    },
  }
}

async function main() {
  const allResults = []
  for (const target of TARGETS) {
    process.stderr.write(`\nProfiling ${target} fetch...\n`)
    const result = await profileTarget(target)
    allResults.push(result)

    console.log(`\n--- ${target} ---`)
    if (result.error) {
      console.log(`  ERROR: ${result.error}`)
      continue
    }
    console.log(`  Runs: ${result.successful}/${result.runs}`)
    const d = result.fetchDuration_ms
    console.log(`  Fetch duration: min=${d.min}ms median=${d.median}ms mean=${d.mean}ms max=${d.max}ms p95=${d.p95}ms p99=${d.p99}ms`)
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(allResults, null, 2))
  process.stderr.write(`\nResults saved to ${OUTPUT_PATH}\n`)
}

main().catch(console.error)
