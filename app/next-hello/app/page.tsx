import { Header } from './header'
import { CardList } from './card-list'

export default async function HomePage() {
  await new Promise(r => setTimeout(r, 1))
  return (
    <main>
      <Header />
      <CardList count={10} />
    </main>
  )
}
