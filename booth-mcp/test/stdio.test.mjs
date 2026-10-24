import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
    assert.deepEqual(client.getServerVersion(), { name: 'booth-mcp', version: '0.5.0' });
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

test('stdio forwards native page_design data and retains legacy text-module input with a fake API', async () => {
  const work = await mkdtemp(join(tmpdir(), 'booth-page-design-'));
  const cookie = join(work, '.cookie');
  await writeFile(cookie, 'synthetic-test-cookie', { mode: 0o600 });
  const client = new Client({ name: 'booth-page-design-check', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', new URL('./mock-item-api.mjs', import.meta.url).href,
      fileURLToPath(new URL('../src/index.js', import.meta.url))],
    env: { PATH: process.env.PATH, BOOTH_COOKIE_FILE: cookie }, stderr: 'pipe' });
  const parse = response => {
    assert.notEqual(response.isError, true);
    return JSON.parse(response.content.find(entry => entry.type === 'text').text);
  };
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === 'booth_update_item').inputSchema;
    assert.ok(schema.properties.page_design);
    assert.equal(schema.properties.page_design_modules.items.additionalProperties, true);
    const page_design = { custom: { keep: true }, modules: [
      { type: 'media', content: '<iframe src="https://video.example/1"></iframe>', extra: true },
      { type: 'future-module', data: ['any', 'native', 'data'] }
    ] };
    await client.callTool({ name: 'booth_update_item', arguments: { item_id: 1, page_design } });
    const saved = parse(await client.callTool({ name: 'booth_get_item', arguments: { item_id: 1 } }));
    assert.deepEqual(saved.page_design, page_design);
    assert.equal(saved.state, 'draft');
    assert.equal(saved.price, 500);
    await client.callTool({ name: 'booth_update_item', arguments: { item_id: 1,
      page_design_modules: [{ title: '見出し', content: '本文' }] } });
    const legacy = parse(await client.callTool({ name: 'booth_get_item', arguments: { item_id: 1 } }));
    assert.deepEqual(legacy.page_design.modules, [{ type: 'text', title: '見出し', content: '本文' }]);
    await client.callTool({ name: 'booth_update_item', arguments: { item_id: 1, page_design: JSON.stringify(page_design) } });
    assert.deepEqual(parse(await client.callTool({ name: 'booth_get_item', arguments: { item_id: 1 } })).page_design, page_design);
  } finally {
    await client.close();
    await rm(work, { recursive: true, force: true });
  }
});
