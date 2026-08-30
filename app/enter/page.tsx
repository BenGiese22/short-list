import { Suspense } from 'react'
import { submitPasscode } from './actions'

export default function EnterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  return (
    <main className="enter-page">
      <Suspense fallback={<PasscodeForm next="/" />}>
        <PasscodeFormWithParams searchParams={searchParams} />
      </Suspense>
    </main>
  )
}

async function PasscodeFormWithParams({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next = '/', error } = await searchParams
  return <PasscodeForm next={next} error={error} />
}

function PasscodeForm({ next, error }: { next: string; error?: string }) {
  return (
    <form action={submitPasscode}>
      <input type="hidden" name="next" value={next} />
      <h1>The Short List</h1>
      <label htmlFor="passcode">Passcode</label>
      <input id="passcode" name="passcode" type="password" autoFocus required />
      {error && <p className="enter-error">Wrong passcode — try again.</p>}
      <button type="submit">Enter</button>
    </form>
  )
}
