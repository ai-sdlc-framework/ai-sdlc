#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const workspacePath = process.env['AI_SDLC_WORKSPACE'] || undefined;
const { server } = await createMcpServer({ workspacePath });
await server.connect(new StdioServerTransport());
