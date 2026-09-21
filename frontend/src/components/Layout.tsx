import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ListOrdered, LogOut, PieChart, Tags } from 'lucide-react'
import { api } from '../lib/api'
import { useSession, useSetSession } from '../lib/auth'
import { cx } from './ui'

const NAV = [
  { to: '/', label: 'Resumen', icon: PieChart, end: true },
  { to: '/movimientos', label: 'Movimientos', icon: ListOrdered, end: false },
  { to: '/categorias', label: 'Categorías', icon: Tags, end: false },
]

/** Barra lateral en escritorio, barra inferior en móvil. */
export function Layout() {
  const { user } = useSession()
  const setSession = useSetSession()
  const navigate = useNavigate()
  const logout = useMutation({
    mutationFn: api.auth.logout,
    onSettled: () => { setSession(null); navigate('/entrar', { replace: true }) },
  })

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[15rem_1fr]">
      <aside className="hidden md:flex flex-col gap-8 sticky top-0 h-dvh px-4 py-6 border-r border-grid bg-sheet">
        <Brand />
        <nav aria-label="Principal" className="flex flex-col gap-1">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => cx(
              'flex items-center gap-3 h-10 px-3 rounded-[var(--radius-control)] text-[15px] font-medium transition-colors',
              isActive ? 'bg-ink text-white' : 'text-ink-soft hover:text-ink hover:bg-rule',
            )}>
              <Icon size={18} strokeWidth={1.75} aria-hidden />{label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto flex flex-col gap-2 text-sm">
          <span className="text-ink-soft truncate" title={user?.email}>{user?.email}</span>
          <button onClick={() => logout.mutate()} className="flex items-center gap-2 text-ink-soft hover:text-ink w-fit">
            <LogOut size={16} aria-hidden /> Cerrar sesión
          </button>
        </div>
      </aside>

      <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-grid bg-sheet">
        <Brand />
        <button onClick={() => logout.mutate()} aria-label="Cerrar sesión" className="p-2 -mr-2 text-ink-soft hover:text-ink">
          <LogOut size={18} />
        </button>
      </header>

      <main className="min-w-0 px-4 md:px-10 pt-6 md:pt-10 pb-28 md:pb-12 max-w-6xl">
        <Outlet />
      </main>

      <nav aria-label="Principal" className="md:hidden fixed inset-x-0 bottom-0 z-10 grid grid-cols-3 border-t border-grid bg-sheet pb-[env(safe-area-inset-bottom)]">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cx(
            'flex flex-col items-center justify-center gap-0.5 h-16 text-xs font-medium',
            isActive ? 'text-ink' : 'text-ink-faint',
          )}>
            <Icon size={20} strokeWidth={1.75} aria-hidden />{label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}

/** Marca: la barra 50/30/20 en miniatura, que es también el favicon. */
export function Brand() {
  return (
    <span className="flex items-center gap-2.5 font-bold text-lg tracking-[-0.01em]">
      <span className="flex h-2.5 w-9 overflow-hidden rounded-sm" aria-hidden>
        <span className="w-1/2 bg-needs" /><span className="w-[30%] bg-wants" /><span className="w-1/5 bg-savings" />
      </span>
      Cuentas
    </span>
  )
}
