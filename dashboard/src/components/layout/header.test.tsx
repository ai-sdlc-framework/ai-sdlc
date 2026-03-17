import { describe, it, expect } from 'vitest';
import { Header } from './header';

describe('Header', () => {
  it('renders with title only', () => {
    const result = Header({ title: 'Test Title' });
    expect(result).toBeTruthy();
    expect(result.type).toBe('header');
    // h1 is the first child
    const h1 = result.props.children[0];
    expect(h1.props.children).toBe('Test Title');
  });

  it('renders with title and subtitle', () => {
    const result = Header({ title: 'Dashboard', subtitle: 'Overview page' });
    expect(result).toBeTruthy();
    // subtitle is the second child (conditional)
    const subtitle = result.props.children[1];
    expect(subtitle).toBeTruthy();
    expect(subtitle.props.children).toBe('Overview page');
  });

  it('does not render subtitle when not provided', () => {
    const result = Header({ title: 'No Sub' });
    const subtitle = result.props.children[1];
    // subtitle should be undefined/falsy since no subtitle prop
    expect(subtitle).toBeFalsy();
  });
});
