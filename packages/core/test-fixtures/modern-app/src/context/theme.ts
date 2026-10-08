import { createContext, use } from 'react';

export type Theme = 'light' | 'dark';
export const ThemeContext = createContext<Theme>('light');

export function useTheme() {
  return use(ThemeContext);
}
