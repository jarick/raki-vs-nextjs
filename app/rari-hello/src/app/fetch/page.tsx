import { Header } from '../../components/header'

export const dynamic = 'force-dynamic'

export default async function FetchPage() {
  const baseUrl = process.env.SELF_URL || 'http://127.0.0.1:3000'
  const fetchStart = Date.now()
  const res = await fetch(`${baseUrl}/data.json`, { cache: 'force-cache' })
  const data = await res.json()
  const fetchDuration = Date.now() - fetchStart

  const payloadSize = new TextEncoder().encode(JSON.stringify(data)).length

  return (
    <main>
      <Header />
      <h2>Fetch Benchmark</h2>
      <table style={{ borderCollapse: 'collapse', marginBottom: 16 }}>
        <tbody>
          <tr>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc', fontWeight: 'bold' }}>Strategy</td>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc' }}>force-cache</td>
          </tr>
          <tr>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc', fontWeight: 'bold' }}>Fetch duration</td>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc' }}>{fetchDuration}ms</td>
          </tr>
          <tr>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc', fontWeight: 'bold' }}>Payload size</td>
            <td style={{ padding: '8px 16px', border: '1px solid #ccc' }}>{payloadSize} bytes</td>
          </tr>
        </tbody>
      </table>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </main>
  )
}
