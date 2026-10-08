import type { LayoutProps } from '@/types';
import { Sidebar } from '.';

export function Layout(props: LayoutProps) {
  return (
    <main className={props.className}>
      <Sidebar selectedId={props.selectedId} onSelect={props.onSelect} user={props.user} />
    </main>
  );
}
