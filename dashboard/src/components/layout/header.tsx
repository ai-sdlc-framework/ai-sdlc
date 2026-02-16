/**
 * Page header component.
 */

interface HeaderProps {
  title: string;
  subtitle?: string;
}

export function Header({ title, subtitle }: HeaderProps) {
  return (
    <header style={{ marginBottom: 24 }}>
      <h1 style={{ margin: 0, fontSize: 24, color: '#0f172a' }}>{title}</h1>
      {subtitle && (
        <p style={{ margin: '4px 0 0', fontSize: 14, color: '#64748b' }}>{subtitle}</p>
      )}
    </header>
  );
}
