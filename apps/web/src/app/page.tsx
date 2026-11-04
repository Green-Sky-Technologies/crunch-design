import { auth } from '@clerk/nextjs/server';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Logo } from '@/components/logo';

export default async function Home() {
  const { userId, orgSlug } = await auth();
  if (userId) redirect(orgSlug ? `/w/${orgSlug}` : '/session-tasks/choose-organization');

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <div className="flex gap-2">
          <Link href="/sign-in" className="btn-ghost">
            Sign in
          </Link>
          <Link href="/sign-up" className="btn-primary">
            Get started
          </Link>
        </div>
      </header>
      <section className="flex flex-1 flex-col justify-center py-24">
        <p className="mb-4 font-mono text-xs uppercase tracking-widest text-accent">Private beta</p>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Describe it. Watch it build. Ship the code.
        </h1>
        <p className="mt-6 max-w-xl text-lg text-muted">
          An AI agent designs on a live HTML canvas, built on your design system. Refine by chat,
          comments, or direct editing, then export to React + Tailwind or Figma.
        </p>
        <div className="mt-10 flex gap-3">
          <Link href="/sign-up" className="btn-primary px-5 py-2.5 text-base">
            Create a workspace
          </Link>
        </div>
      </section>
    </main>
  );
}
