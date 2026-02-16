import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'AI-SDLC Dashboard',
  description: 'Engineering manager dashboard for AI-SDLC pipeline operations',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{ display: 'flex' }}>
          <nav style={{
            width: 200,
            minHeight: '100vh',
            borderRight: '1px solid #e2e8f0',
            padding: '16px 0',
            backgroundColor: '#f8fafc',
          }}>
            <div style={{ padding: '0 16px 16px', fontWeight: 700, fontSize: 16 }}>
              AI-SDLC
            </div>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {[
                { href: '/', label: 'Overview' },
                { href: '/cost', label: 'Cost' },
                { href: '/autonomy', label: 'Autonomy' },
                { href: '/codebase', label: 'Codebase' },
                { href: '/audit', label: 'Audit' },
              ].map((item) => (
                <li key={item.href}>
                  <a href={item.href} style={{
                    display: 'block',
                    padding: '8px 16px',
                    color: '#475569',
                    textDecoration: 'none',
                    fontSize: 14,
                  }}>
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main style={{ flex: 1, padding: 24 }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
