import { can } from '@crunch/authz';
import { redirect } from 'next/navigation';
import { CredentialManager } from '@/components/credential-manager';
import { db, requireActor } from '@/server/context';
import { deploymentGatewayConfig } from '@/server/services/ai-gateway';
import { getExternalId, getPublicCredential } from '@/server/services/credentials';

export const metadata = { title: 'Model access' };

export default async function CredentialsPage({
  params,
}: PageProps<'/w/[slug]/settings/credentials'>) {
  const actor = await requireActor((await params).slug);
  if (!can(actor.role, 'workspace:manage_credentials')) redirect(`/w/${actor.workspace.slug}`);
  const [credential, externalId] = await Promise.all([
    getPublicCredential(db(), actor),
    getExternalId(db(), actor.workspace.id),
  ]);
  const deploymentGateway = deploymentGatewayConfig().enabled;

  return (
    <main className="w-full max-w-3xl">
      <h1 className="mb-1 text-2xl font-semibold tracking-tight">Model access</h1>
      <p className="mb-6 text-sm text-muted">
        {deploymentGateway
          ? 'How the agent reaches Claude for every member of this workspace.'
          : 'CrunchDesign is bring-your-own-key. The agent uses this workspace credential for every member, and usage is billed to your provider account. Secrets are encrypted at rest and never shown again after saving.'}
      </p>
      <CredentialManager
        deploymentGateway={deploymentGateway}
        initial={credential}
        externalId={externalId}
        awsPrincipalArn={process.env.CRUNCH_AWS_PRINCIPAL_ARN ?? null}
      />
    </main>
  );
}
