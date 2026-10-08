import type { User } from '@/types';

export async function getUser(): Promise<User | null> {
  return { id: '1', name: 'Ada' };
}
