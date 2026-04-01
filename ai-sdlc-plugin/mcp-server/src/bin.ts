#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPluginMcpServer } from './server.js';

const { server } = createPluginMcpServer();
await server.connect(new StdioServerTransport());
