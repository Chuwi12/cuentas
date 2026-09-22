import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useSession, useSetSession } from '../lib/auth'
import { Brand } from '../components/Layout'
import { Button, ErrorNote, Field, Skeleton, TextInput } from '../components/ui'
import { BUCKETS, BUCKET_ORDER } from '../lib/buckets'

/** Pantalla de acceso: el servidor decide el modo (registro solo la primera
 *  vez, luego entrar). No hay conmutador manual entre ambos. */
export default function LoginPage() {
  const { user } = useSession()
  const location = useLocation()
  const navigate = useNavigate()
  const setSession = useSetSession()

  const status = useQuery({
    queryKey: ['auth-status'],
    queryFn: api.auth.status,
    retry: false,
  })
  const mode: 'register' | 'login' | null = status.data
    ? (status.data.registration_open ? 'register' : 'login')
    : null

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [closedNotice, setClosedNotice] = useState(false)

  const mutation = useMutation({
    mutationFn: () => mode === 'register'
      ? api.auth.register(email, password)
      : api.auth.login(email, password),
    onSuccess: (res) => {
      setSession(res.user)
      const from = (location.state as { from?: string } | null)?.from ?? '/'
      navigate(from, { replace: true })
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'registration_closed') {
        setClosedNotice(true)
        status.refetch()
        return
      }
      setFormError(err instanceof ApiError ? err.message : 'Algo ha fallado. Inténtalo de nuevo.')
    },
  })

  if (user) {
    const from = (location.state as { from?: string } | null)?.from ?? '/'
    return <Navigate to={from} replace />
  }

  const minLength = 12
  const remaining = Math.max(0, minLength - password.length)
  const lengthMessage = password.length === 0
    ? `Mínimo ${minLength} caracteres.`
    : remaining > 0
      ? `Faltan ${remaining} caracter${remaining === 1 ? '' : 'es'} para llegar al mínimo de ${minLength}.`
      : `Cumple el mínimo de ${minLength} caracteres.`
  const passwordTooShort = mode === 'register' && password.length < minLength
  const passwordsMismatch = mode === 'register' && confirmPassword.length > 0 && confirmPassword !== password

  function clearErrors() {
    setFormError(null)
    setClosedNotice(false)
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!mode) return
    setSubmitted(true)
    setFormError(null)
    if (mode === 'register' && (passwordTooShort || password !== confirmPassword)) return
    mutation.mutate()
  }

  return (
    <div className="min-h-dvh flex flex-col md:flex-row items-stretch bg-paper">
      <section className="graph-paper flex items-center justify-center px-6 py-8 md:flex-1 md:py-16 border-b md:border-b-0 md:border-r border-grid">
        <div className="w-full max-w-sm">
          <Brand />
          <h1 className="mt-6 text-2xl md:text-[28px] font-bold tracking-[-0.01em] text-ink">Tus cuentas del mes</h1>
          <p className="mt-3 text-ink-soft leading-relaxed">
            Apunta lo que entra y lo que sale, y mira cómo se reparte entre necesidades, deseos y ahorro.
          </p>

          <div className="mt-6 md:mt-8">
            <div className="flex h-9 md:h-12 rounded-[6px] overflow-hidden" aria-hidden="true">
              {BUCKET_ORDER.map((b) => (
                <div key={b} className={BUCKETS[b].bg} style={{ width: `${BUCKETS[b].pct}%` }} />
              ))}
            </div>
            <div className="flex mt-2 md:mt-3 text-sm">
              {BUCKET_ORDER.map((b) => (
                <div key={b} style={{ width: `${BUCKETS[b].pct}%` }} className="pr-2">
                  <p className={`font-semibold ${BUCKETS[b].text}`}>{BUCKETS[b].label}</p>
                  <p className="text-ink-soft">{BUCKETS[b].pct}%</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="flex items-center justify-center px-4 py-10 md:flex-1 md:px-10">
        <div className="w-full max-w-96 bg-sheet border border-grid rounded-[var(--radius-panel)] shadow-[var(--shadow-lift)] p-6 md:p-8">
          {mode === null ? (
            status.isError ? (
              <ErrorNote error={status.error} onRetry={() => status.refetch()} />
            ) : (
              <div className="flex flex-col gap-4" aria-busy="true">
                <Skeleton className="h-7 w-32" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            )
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <h2 className="text-xl font-bold text-ink">
                {mode === 'register' ? 'Crea tu cuenta' : 'Entrar'}
              </h2>
              {mode === 'register' ? (
                <p className="mt-1.5 text-sm text-ink-soft">
                  Cuentas es solo para ti: esta es la única vez que se puede crear una cuenta.
                </p>
              ) : null}

              {closedNotice && mode === 'login' ? (
                <p className="mt-3 text-sm text-ink-soft bg-rule rounded-[var(--radius-control)] px-3 py-2">
                  El registro ya está cerrado: ya hay una cuenta creada. Entra con ella.
                </p>
              ) : null}

              <div className="mt-5 flex flex-col gap-4">
                <Field label="Correo electrónico">
                  {(props) => (
                    <TextInput
                      {...props}
                      type="email"
                      autoComplete="username"
                      required
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); clearErrors() }}
                    />
                  )}
                </Field>

                <Field
                  label="Contraseña"
                  error={mode === 'register' && submitted && passwordTooShort ? lengthMessage : undefined}
                  hint={mode === 'register' && !(submitted && passwordTooShort) ? lengthMessage : undefined}
                >
                  {(props) => (
                    <div className="relative">
                      <TextInput
                        {...props}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                        required
                        minLength={mode === 'register' ? minLength : undefined}
                        className="pr-11"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); clearErrors() }}
                      />
                      <button
                        type="button"
                        aria-pressed={showPassword}
                        aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute inset-y-0 right-0 flex items-center px-3 text-ink-soft hover:text-ink"
                      >
                        {showPassword ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}
                      </button>
                    </div>
                  )}
                </Field>

                {mode === 'register' ? (
                  <Field
                    label="Confirma la contraseña"
                    error={passwordsMismatch || (submitted && confirmPassword !== password)
                      ? 'Las contraseñas no coinciden.' : undefined}
                  >
                    {(props) => (
                      <TextInput
                        {...props}
                        type={showPassword ? 'text' : 'password'}
                        autoComplete="new-password"
                        required
                        value={confirmPassword}
                        onChange={(e) => { setConfirmPassword(e.target.value); clearErrors() }}
                      />
                    )}
                  </Field>
                ) : null}

                {formError ? <ErrorNote error={new Error(formError)} /> : null}

                <Button type="submit" loading={mutation.isPending} className="w-full mt-1">
                  {mode === 'register' ? 'Crear cuenta' : 'Entrar'}
                </Button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  )
}
