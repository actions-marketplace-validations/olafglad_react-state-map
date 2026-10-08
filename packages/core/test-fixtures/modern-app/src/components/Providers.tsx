'use client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeContext, type Theme } from '@/context/theme';
import { AuthProvider } from '@/context/auth';

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme] = useState<Theme>('dark');
  const [client] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={client}>
      <ThemeContext value={theme}>
        <AuthProvider>{children}</AuthProvider>
      </ThemeContext>
    </QueryClientProvider>
  );
}
