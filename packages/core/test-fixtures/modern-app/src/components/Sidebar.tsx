import { forwardRef } from 'react';
import { Menu } from './index';
import type { User } from '@/types';

interface SidebarProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
  user: User | null;
}

export default forwardRef<HTMLElement, SidebarProps>(function Sidebar({ user, ...rest }, ref) {
  return (
    <aside ref={ref}>
      <span>{user?.name}</span>
      <Menu {...rest} />
    </aside>
  );
});
