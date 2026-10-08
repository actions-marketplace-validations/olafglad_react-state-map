import { useQuery } from '@tanstack/react-query';
import { useAtom } from 'jotai';
import { useAuth } from '@/context/auth';
import { useTheme } from '@/context/theme';
import { filterAtom } from '@/state/atoms';

export function UserMenu({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const { user, logout } = useAuth();
  const theme = useTheme();
  const { data: items } = useQuery({ queryKey: ['menu-items'], queryFn: () => fetch('/api/items').then(r => r.json()) });
  const [filter, setFilter] = useAtom(filterAtom);

  return (
    <ul className={theme}>
      <input value={filter} onChange={e => setFilter(e.target.value)} />
      {items?.map((item: { id: string }) => (
        <li key={item.id} aria-selected={item.id === selectedId} onClick={() => onSelect(item.id)}>
          {item.id}
        </li>
      ))}
      <button onClick={logout}>{user?.name}</button>
    </ul>
  );
}
