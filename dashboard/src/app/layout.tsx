import type { Metadata } from 'next';
import { coreNavItems, getNavItems, type NavItem } from '@/lib/nav-items';

export const metadata: Metadata = {
  title: 'AI-SDLC Dashboard',
  description: 'Engineering manager dashboard for AI-SDLC pipeline operations',
};

async function NavLinks() {
  let items: NavItem[];
  try {
    items = await getNavItems();
  } catch {
    items = coreNavItems;
  }

  // Group items: ungrouped first, then by section
  const ungrouped = items.filter((i) => !i.section);
  const sections = new Map<string, NavItem[]>();
  for (const item of items) {
    if (item.section) {
      const list = sections.get(item.section) ?? [];
      list.push(item);
      sections.set(item.section, list);
    }
  }

  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {ungrouped.map((item) => (
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
      {Array.from(sections.entries()).map(([section, sectionItems]) => (
        <li key={section}>
          <div style={{
            padding: '12px 16px 4px',
            fontSize: 11,
            fontWeight: 600,
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
          }}>
            {section}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {sectionItems.map((item) => (
              <li key={item.href}>
                <a href={item.href} style={{
                  display: 'block',
                  padding: '8px 16px 8px 24px',
                  color: '#475569',
                  textDecoration: 'none',
                  fontSize: 14,
                }}>
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

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
            {/* @ts-expect-error Async Server Component */}
            <NavLinks />
          </nav>
          <main style={{ flex: 1, padding: 24 }}>
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
