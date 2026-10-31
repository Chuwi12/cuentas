import { useEffect, useRef } from 'react'
import { ApiError } from '../../lib/api'
import type { AsesorEvent } from '../../lib/types'

export interface StreamHandlers {
  onDelta: (text: string) => void
  onDone: (event: Extract<AsesorEvent, { type: 'done' }>) => void
  onFail: (error: Error) => void
  onStop: () => void
}

/** Errores de la API del asesor en una frase para el usuario. 409: otra generación en curso;
 *  503 `asesor_unavailable` y el resto: el mensaje del servidor, que ya viene en español. */
export function describeError(e: unknown): Error {
  if (e instanceof ApiError) {
    return e.status === 409
      ? new Error('El asesor está ocupado con otra generación. Espera a que termine e inténtalo de nuevo.')
      : e
  }
  return new Error('Algo ha fallado al hablar con el asesor.')
}

/** Consume un stream del asesor y lo traduce a cuatro desenlaces: delta, done, fallo o parada.
 *  Abortar con `ctrl` es una parada (`onStop`), no un fallo. Un stream que se cierra sin `done`
 *  ni `error` cuenta como fallo, igual que una lectura que lanza: el backend corta la conexión sin
 *  avisar si el asesor muere o se queda 10 min sin datos, y un texto a medias nunca se da por terminado. */
export async function runStream(
  start: (onEvent: (e: AsesorEvent) => void, signal: AbortSignal) => Promise<void>,
  ctrl: AbortController,
  h: StreamHandlers,
): Promise<void> {
  let finished = false
  try {
    await start((e) => {
      if (e.type === 'delta') h.onDelta(e.text)
      else if (e.type === 'done') { finished = true; h.onDone(e) }
      else if (e.type === 'error') { finished = true; h.onFail(new Error(e.message)) }
    }, ctrl.signal)
    if (!finished) h.onFail(new Error('La conexión con el asesor se cortó antes de terminar.'))
  } catch (e) {
    if (ctrl.signal.aborted) h.onStop()
    else h.onFail(describeError(e))
  }
}

/** Un AbortController por generación; se aborta solo al salir de la página (el servidor
 *  cancela entonces la generación en el modelo). */
export function useAbortable() {
  const ref = useRef<AbortController | null>(null)
  useEffect(() => () => ref.current?.abort(), [])
  return {
    begin: () => (ref.current = new AbortController()),
    stop: () => ref.current?.abort(),
  }
}
