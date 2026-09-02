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
    <ol className="stepper" aria-label={`Genie status: ${status}`}>
      {STEPS.map((s) => {
        const sRank = ORDER.indexOf(s.key)
        const state = rank > sRank ? 'done' : rank === sRank || (s.key === 'EXECUTING_QUERY' && status === 'PENDING_WAREHOUSE') ? 'active' : 'todo'
        return (
          <li key={s.key} className={`step step-${state}`}>
            <span className="step-dot" />
            {s.label}
          </li>
        )
      })}
      <li className="step-raw">{status}</li>
    </ol>
  )
}
