/**
 * Emit the cron routes' *decisions* as a queryable dimension.
 *
 * These routes fail in one specific way: HTTP 200, valid JSON, no exception,
 * and the wrong word inside. The resume loop was six consecutive responses
 * saying `collect-and-stop` where they should have said `noop`, and it was
 * only ever visible to a human who already knew which word was right.
 *
 * Nothing in the standard toolkit sees that. Error rates, latency and
 * status-code dashboards all key on signals a run of clean 200s never
 * produces. Custom metrics are the one native surface that can carry a
 * semantic value, because the tags become dimensions you can filter and
 * alert on:
 *
 *   vercel metrics pipeline.decision --filter "outcome:collect-and-stop"
 *
 * Six of those in an hour is then a shape on a chart rather than something
 * somebody has to notice.
 *
 * This does not prevent anything -- verify.py and the handlers' own guards
 * do that. It makes a wrong decision visible over time, which is the part
 * reading logs by hand was doing badly.
 */

export const DECISION_METRIC = 'pipeline.decision'

/** Matches `metric` from @vercel/functions; injected so tests need no runtime. */
export type Emit = (name: string, value: number, tags?: Record<string, string>) => void

export type Route = 'run' | 'reap'

function tag(value: unknown): string {
  // Tags must be strings, and low-cardinality: these become dimensions.
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number') return String(value)
  return 'none'
}

/**
 * The single word describing what the route decided.
 *
 * Deliberately one field rather than several booleans: it is the thing you
 * want to group by, and the thing that was wrong in every incident so far.
 */
export function outcomeOf(route: Route, httpStatus: number, body: Record<string, unknown>): string {
  if (httpStatus >= 500) return 'error'
  if (httpStatus === 401) return 'unauthorized'
  if (route === 'reap') {
    if (body.idle === true) return 'idle'
    return tag(body.action)
  }
  if (body.started === true) return 'started'
  if (typeof body.skipped === 'string') return `skipped:${body.skipped}`
  return 'unknown'
}

export function decisionTags(
  route: Route,
  httpStatus: number,
  bodyText: string,
): Record<string, string> {
  let body: Record<string, unknown> = {}
  try {
    const parsed = JSON.parse(bodyText)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed
  } catch {
    // A body we cannot parse is itself worth seeing as `outcome=unknown`
    // rather than dropping the whole event.
  }
  return {
    route,
    http_status: String(httpStatus),
    outcome: outcomeOf(route, httpStatus, body),
    sandbox_status: tag(body.status),
    job: tag(body.job),
  }
}

/**
 * Never throws. A metric is commentary on a request that has already been
 * answered; failing to describe what happened must not change what happened.
 */
export function emitDecision(
  emit: Emit,
  route: Route,
  httpStatus: number,
  bodyText: string,
): void {
  try {
    emit(DECISION_METRIC, 1, decisionTags(route, httpStatus, bodyText))
  } catch {
    // Deliberately silent: this is the observability path, and an
    // observability path that can break the thing it observes is worse than
    // no observability path.
  }
}
