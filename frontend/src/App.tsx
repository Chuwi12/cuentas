import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { Layout } from './components/Layout'
import { useSession } from './lib/auth'
import { ErrorNote } from './components/ui'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import TransactionsPage from './pages/TransactionsPage'
import CategoriesPage from './pages/CategoriesPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading, error } = useSession()
  const location = useLocation()
  if (isLoading) return <div className="min-h-dvh" aria-busy="true" />
  if (error) return <div className="p-6"><ErrorNote error={error} onRetry={() => window.location.reload()} /></div>
  if (!user) return <Navigate to="/entrar" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

export default function App() {
  return (
    <Routes>
      <Route path="/entrar" element={<LoginPage />} />
      <Route element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
        <Route path="movimientos" element={<TransactionsPage />} />
        <Route path="categorias" element={<CategoriesPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
