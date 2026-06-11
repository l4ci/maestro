// CI failing-log assembly shared by both adapters (#120). Job traces / check outputs are
// large and the actual failure is almost always at the tail, so each section keeps its last
// CI_SECTION_MAX chars and the whole block is capped at CI_LOG_MAX — bounding the size of
// the forge comment the daemon threads into the cold session.

const CI_SECTION_MAX = 2000;
const CI_LOG_MAX = 4000;

/** Keep the last `max` chars (failures cluster at the end), normalizing CRLF and trimming. */
function tail(text: string, max: number): string {
  const t = text.replace(/\r\n/g, '\n').trimEnd();
  return t.length <= max ? t : `…(truncated)\n${t.slice(t.length - max)}`;
}

/** One failed job/check, headed by its name, tail-truncated to the per-section bound. */
export function formatJobLog(name: string, body: string): string {
  return `── ${name} ──\n${tail(body, CI_SECTION_MAX)}`;
}

/** The assembled block, tail-truncated to the overall bound. */
export function truncateCiLogs(body: string): string {
  return tail(body, CI_LOG_MAX);
}
