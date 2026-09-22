// Paleta cerrada de colores para categorías. Vive aquí (no en styles/app.css)
// porque no son tokens de la interfaz sino datos de usuario: el color que
// alguien elige para "Ocio" o "Comida". Los 12 tonos están pensados para que
// un icono BLANCO se lea bien encima (fila con icono en círculo de color) y
// para no chocar con los tokens de cubo (needs/wants/savings) ni con el rojo
// de corrección (--color-over), reservado a "te has pasado del objetivo".
export interface PaletteColor {
  hex: string
  name: string
}

export const CATEGORY_COLORS: PaletteColor[] = [
  { hex: '#1e4d73', name: 'Azul marino' },
  { hex: '#0369a1', name: 'Celeste' },
  { hex: '#0f766e', name: 'Verde azulado' },
  { hex: '#15803d', name: 'Verde' },
  { hex: '#65a30d', name: 'Lima' },
  { hex: '#b45309', name: 'Ámbar' },
  { hex: '#c2410c', name: 'Naranja' },
  { hex: '#a21caf', name: 'Fucsia' },
  { hex: '#be185d', name: 'Rosa' },
  { hex: '#7c3aed', name: 'Violeta' },
  { hex: '#4338ca', name: 'Índigo' },
  { hex: '#78350f', name: 'Marrón' },
]

export const DEFAULT_CATEGORY_COLOR = CATEGORY_COLORS[0].hex
