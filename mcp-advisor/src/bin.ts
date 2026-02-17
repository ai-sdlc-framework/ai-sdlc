#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const { server } = await createMcpServer();
await server.connect(new StdioServerTransport());
