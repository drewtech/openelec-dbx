/**
 * Ported from web/client/src/components/StatusStepper.tsx — logic and status values are
 * identical (both ride the same Genie message `status` field), restyled with Tailwind classes
 * to match this app's shadcn-based design system instead of web/'s hand-written CSS.
 */
const STEPS: { key: string; label: string }[] = [
  { key: 'QUEUED', label: 'Waiting for a slot' },
  { key: 'FILTERING_CONTEXT', label: 'Choosing tables' },
  { key: 'ASKING_AI', label: 'Writing SQL' },
  { key: 'EXECUTING_QUERY', label: 'Running on warehouse' },
  { key: 'COMPLETED', label: 'Done' },
]

const ORDER = ['QUEUED', 'SUBMITTED', 'FILTERING_CONTEXT', 'ASKING_AI', 'PENDING_WAREHOUSE', 'EXECUTING_QUERY', 'COMPLETED']

export function StatusStepper({ status }: { status: string }) {
  const rank = ORDER.indexOf(status)
  return (
    <ol aria-label={`Genie status: ${status}`} className="flex flex-wrap items-center gap-4 py-1 text-sm">
      {STEPS.map((s) => {
        const sRank = ORDER.indexOf(s.key)
        const state = rank > sRank ? 'done' : rank === sRank || (s.key === 'EXECUTING_QUERY' && status === 'PENDING_WAREHOUSE') ? 'active' : 'todo'
        return (
          <li
            key={s.key}
            className={`flex items-center gap-1.5 ${
              state === 'done' ? 'text-foreground' : state === 'active' ? 'text-foreground font-medium' : 'text-muted-foreground'
            }`}
          >
            <span
              className={`h-[9px] w-[9px] rounded-full ${
                state === 'done' ? 'bg-success' : state === 'active' ? 'bg-primary animate-pulse' : 'bg-border'
              }`}
            />
            {s.label}
          </li>
        )
      })}
      <li className="ml-auto font-mono text-xs text-muted-foreground">{status}</li>
    </ol>
  )
}
