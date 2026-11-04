import { clerkMiddleware } from '@clerk/nextjs/server';

/**
 * Clerk session handling only. Authorization happens next to each resource:
 * every page, server action and route handler calls `requireActor()` / `getActor()`
 * from `@/server/context` and checks permissions with `@crunch/authz`.
 * (Clerk deprecated route-matcher protection in middleware.)
 */
export default clerkMiddleware({
  // Activate the workspace named in the URL (/w/:slug/...) on page navigations.
  organizationSyncOptions: { organizationPatterns: ['/w/:slug', '/w/:slug/(.*)'] },
});

export const config = {
  matcher: [
    // Skip Next internals and static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
