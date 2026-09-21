import {
  Baby, Banknote, Bike, BookOpen, Briefcase, Bus, Car, Circle, CirclePlus, Coffee, CreditCard,
  Dumbbell, Fuel, Gamepad2, Gift, GraduationCap, HandCoins, Heart, House, Landmark, Laptop,
  PartyPopper, PawPrint, PiggyBank, Pill, Plane, Receipt, Shirt, ShoppingCart, Smartphone,
  Stethoscope, TrendingUp, Tv, Utensils, Wallet, Wifi, Wrench, Zap,
  type LucideIcon,
} from 'lucide-react'

/**
 * Catálogo cerrado de iconos para categorías. Las claves son los nombres
 * kebab-case de lucide que se guardan en BD (ver docs/API.md). Mapa estático
 * y no DynamicIcon: evita cargar cada icono en diferido (parpadeo en listas).
 */
export const CATEGORY_ICONS: Record<string, LucideIcon> = {
  wallet: Wallet, 'circle-plus': CirclePlus, banknote: Banknote, briefcase: Briefcase,
  'hand-coins': HandCoins, house: House, utensils: Utensils, 'shopping-cart': ShoppingCart,
  zap: Zap, wifi: Wifi, smartphone: Smartphone, bus: Bus, car: Car, fuel: Fuel, bike: Bike,
  plane: Plane, dumbbell: Dumbbell, shirt: Shirt, 'party-popper': PartyPopper, coffee: Coffee,
  'gamepad-2': Gamepad2, tv: Tv, 'book-open': BookOpen, 'graduation-cap': GraduationCap,
  gift: Gift, heart: Heart, pill: Pill, stethoscope: Stethoscope, 'paw-print': PawPrint,
  baby: Baby, wrench: Wrench, laptop: Laptop, receipt: Receipt, 'credit-card': CreditCard,
  'trending-up': TrendingUp, 'piggy-bank': PiggyBank, landmark: Landmark, circle: Circle,
}

export function CategoryIcon({ name, className, size = 18 }: {
  name: string; className?: string; size?: number
}) {
  const Icon = CATEGORY_ICONS[name] ?? Circle
  return <Icon className={className} size={size} strokeWidth={1.75} aria-hidden />
}
