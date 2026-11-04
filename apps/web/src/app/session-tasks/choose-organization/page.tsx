import { TaskChooseOrganization } from '@clerk/nextjs';
import { Logo } from '@/components/logo';

/** Shown after sign-in when the user has no active workspace (Clerk "Membership required"). */
export default function Page() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <Logo />
      <p className="max-w-sm text-center text-sm text-muted">
        Create a workspace for your team, or join one you&apos;ve been invited to.
      </p>
      <TaskChooseOrganization redirectUrlComplete="/" />
    </main>
  );
}
