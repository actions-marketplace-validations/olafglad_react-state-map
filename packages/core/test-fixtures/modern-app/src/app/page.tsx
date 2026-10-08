import { Shell } from '@/components';
import { getUser } from '@/state/server';

export default async function Page() {
  const user = await getUser();
  return <Shell user={user} />;
}
