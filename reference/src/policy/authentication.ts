/**
 * Authentication layer for AI-SDLC Framework.
 * Provides token-based identity verification for agents and services.
 */

export interface AuthIdentity {
  actor: string;
  actorType: 'ai-agent' | 'human' | 'bot' | 'service-account';
  roles: string[];
  groups: string[];
  scopes: string[];
}

export interface AuthenticationResult {
  success: boolean;
  identity?: AuthIdentity;
  reason?: string;
}

export interface Authenticator {
  authenticate(token: string): Promise<AuthenticationResult>;
}

/**
 * Create a token-based authenticator backed by a simple map.
 * Suitable for testing and development.
 */
export function createTokenAuthenticator(tokenMap: Map<string, AuthIdentity>): Authenticator {
  return {
    async authenticate(token: string): Promise<AuthenticationResult> {
      const identity = tokenMap.get(token);
      if (!identity) {
        return { success: false, reason: 'Invalid token' };
      }
      return { success: true, identity };
    },
  };
}

/**
 * Create an authenticator that always succeeds with the given identity.
 * Useful for testing and development environments.
 */
export function createAlwaysAuthenticator(identity: AuthIdentity): Authenticator {
  return {
    async authenticate(_token: string): Promise<AuthenticationResult> {
      return { success: true, identity };
    },
  };
}
