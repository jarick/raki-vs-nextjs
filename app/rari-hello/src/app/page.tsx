import { Header } from '../components/header'
import { CardList } from '../components/card-list'

export const dynamic = 'force-dynamic'

export default async function HomePage() {
  await new Promise(r => setTimeout(r, 1))
  return (
    <main>
      <Header />
      <CardList count={10} />
    </main>
  )
}
