export async function Card({ title, description }: { title: string; description: string }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <div style={{ padding: 16, border: '1px solid #ccc', borderRadius: 8 }}>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  )
}
