import { useEffect, useState } from 'react'

/** Devuelve `value` con retraso `delay` ms tras el último cambio. Para búsquedas. */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}
