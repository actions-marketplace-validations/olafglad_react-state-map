'use client';
import React, { memo } from 'react';
import { Layout } from './Layout';
import { Button } from '@/components/ui/Button';
import type { User } from '@/types';

type ShellProps = {
  user: User | null;
  onLogout?: () => void;
};

export const Shell = memo(function Shell({ user, onLogout }: ShellProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  return (
    <div>
      <Button label="Log out" onClick={onLogout} />
      <Layout user={user} selectedId={selectedId} onSelect={setSelectedId} />
    </div>
  );
});
