import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('stdio MCP initializes and advertises 17 tools including download verification without a BOOTH request', async () => {
  const client = new Client({ name: 'booth-maintenance-check', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { PATH: process.env.PATH, BOOTH_COOKIE: 'synthetic-unused-test-cookie' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    assert.deepEqual(client.getServerVersion(), { name: 'booth-mcp', version: '0.4.0' });
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
    assert.equal(new Set(tools.map(tool => tool.name)).size, 17);
    assert.ok(tools.some(tool => tool.name === 'booth_replace_download'));
    assert.ok(tools.some(tool => tool.name === 'booth_get_item'));
    const download = tools.find(tool => tool.name === 'booth_download_and_verify');
    assert.ok(download.inputSchema.required.includes('expected_sha256'));
  } finally {
    await client.close();
  }
});
