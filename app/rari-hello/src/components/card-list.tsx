import { Card } from './card'

export async function CardList({ count }: { count: number }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} title={`Item ${i + 1}`} description={`Description for item ${i + 1}`} />
      ))}
    </div>
  )
}
