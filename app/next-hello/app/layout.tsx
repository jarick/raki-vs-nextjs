export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await new Promise(r => setTimeout(r, 1))
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
