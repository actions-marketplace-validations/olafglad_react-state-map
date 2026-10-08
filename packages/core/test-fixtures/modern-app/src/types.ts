export interface User {
  id: string;
  name: string;
}

export interface BaseProps {
  className?: string;
}

export interface LayoutProps extends BaseProps {
  user: User | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
}
