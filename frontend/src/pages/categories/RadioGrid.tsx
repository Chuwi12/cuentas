// Rejilla de opciones tipo radio (color, icono): un solo elemento en el orden
// de tabulación (roving tabindex) y flechas para moverse, como pide un
// radiogroup accesible de verdad. Se usa dos veces en CategoryFormDialog.
import { useRef, type KeyboardEvent, type ReactNode } from 'react'

export interface RadioGridOption<T extends string> {
  value: T
  label: string
  render: (selected: boolean) => ReactNode
}

export function RadioGrid<T extends string>({ legend, options, value, onChange, columns = 6 }: {
  legend: string
  options: RadioGridOption<T>[]
  value: T
  onChange: (v: T) => void
  columns?: number
}) {
  const ref = useRef<HTMLDivElement>(null)

  function focusValue(v: T) {
    requestAnimationFrame(() => {
      ref.current?.querySelector<HTMLButtonElement>(`[data-value="${v}"]`)?.focus()
    })
  }

  function move(delta: number) {
    const idx = options.findIndex((o) => o.value === value)
    const next = options[Math.min(Math.max(idx + delta, 0), options.length - 1)]
    if (next) { onChange(next.value); focusValue(next.value) }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(columns) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-columns) }
    else if (e.key === 'Home') { e.preventDefault(); onChange(options[0].value); focusValue(options[0].value) }
    else if (e.key === 'End') {
      e.preventDefault()
      onChange(options[options.length - 1].value)
      focusValue(options[options.length - 1].value)
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{legend}</span>
      <div
        ref={ref}
        role="radiogroup"
        aria-label={legend}
        onKeyDown={onKeyDown}
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {options.map((o) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={o.label}
              title={o.label}
              data-value={o.value}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(o.value)}
              className="flex items-center justify-center size-10 rounded-full"
            >
              {o.render(selected)}
            </button>
          )
        })}
      </div>
    </div>
  )
}
