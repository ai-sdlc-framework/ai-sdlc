/**
 * Navigation sidebar.
 */

const navItems = [
  { href: '/', label: 'Overview' },
  { href: '/cost', label: 'Cost' },
  { href: '/autonomy', label: 'Autonomy' },
  { href: '/codebase', label: 'Codebase' },
  { href: '/audit', label: 'Audit' },
];

export function Sidebar({ currentPath }: { currentPath: string }) {
  return (
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
        {navItems.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              style={{
                display: 'block',
                padding: '8px 16px',
                color: currentPath === item.href ? '#1d4ed8' : '#475569',
                backgroundColor: currentPath === item.href ? '#eff6ff' : 'transparent',
                textDecoration: 'none',
                fontSize: 14,
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
