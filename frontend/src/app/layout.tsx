import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ToastProvider } from '@/hooks/useToast';
import { ThemeProvider, themeScript } from '@/hooks/useTheme';
import { Toaster } from '@/components/ui/Toaster';
import './globals.css';

export const metadata: Metadata = {
  title: 'ONE — Email Scheduler',
  description: 'Schedule and send email campaigns at scale with BullMQ, Redis and Postgres.',
};

export default function RootLayout({ children }: { children: ReactNode }): ReactNode {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          Applies the stored theme before first paint. In an effect this would
          paint light first and then snap to dark -- the classic flash.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-canvas text-ink antialiased">
        <ThemeProvider>
          <ToastProvider>
            {children}
            <Toaster />
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
