export async function Header() {
  await new Promise(r => setTimeout(r, 1))
  return <h1>Rari vs Next.js Benchmark</h1>
}
