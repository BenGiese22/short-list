/**
 * Push an alert to the phone via ntfy.
 *
 * Never throws and never waits long. An alert is commentary on a decision
 * that has already been made; neither cron route should fail because the
 * notification service did.
 */
export async function notify(title: string, message: string) {
  const topic = process.env.NTFY_TOPIC
  if (!topic) return
  try {
    await fetch(`https://ntfy.sh/${topic}`, {
      method: 'POST',
      headers: { Title: title, Priority: 'high' },
      body: message,
      signal: AbortSignal.timeout(5000),
    })
  } catch {
    // See above: best-effort by design.
  }
}
