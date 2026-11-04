import type { Metadata } from 'next';
import { ClerkProvider } from '@clerk/nextjs';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] });
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: { default: 'CrunchDesign', template: '%s · CrunchDesign' },
  description: 'Design with an AI agent on a live HTML canvas.',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <ClerkProvider
          taskUrls={{ 'choose-organization': '/session-tasks/choose-organization' }}
          appearance={{
            // Solarized Light, matching globals.css
            variables: {
              colorPrimary: '#cb4b16',
              colorBackground: '#fdf6e3',
              colorForeground: '#586e75',
              colorMutedForeground: '#657b83',
              colorInput: '#fdf6e3',
            },
          }}
        >
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
