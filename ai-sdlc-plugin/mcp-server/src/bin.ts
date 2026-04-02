#!/usr/bin/env node
/* v8 ignore start — entry point bootstraps stdio transport, not unit-testable */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPluginMcpServer } from './server.js';

const { server } = createPluginMcpServer();
await server.connect(new StdioServerTransport());
/* v8 ignore stop */
