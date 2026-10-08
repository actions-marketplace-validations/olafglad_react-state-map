import { Shell } from '@/components';

export default function SettingsPage() {
  return <Shell user={null} onLogout={() => console.log('logout')} />;
}
