// Imported only by the isolated stdio test. Never contacts BOOTH or another host.
let item = { id: 1, name: 'fixture', state: 'draft', price: 500, page_design: { modules: [] } };
globalThis.fetch = async (value, options = {}) => {
  const url = new URL(value);
  if (url.origin !== 'https://manage.booth.pm') throw new Error('Network blocked by test fixture');
  if (url.pathname === '/items' && !options.method) {
    return new Response('<meta name="csrf-token" content="synthetic-csrf">');
  }
  if (url.pathname === '/items/1' && !options.method) return Response.json(item);
  if (url.pathname === '/items/1' && options.method === 'PATCH') {
    item = JSON.parse(options.body).item;
    if (typeof item.page_design === 'string') item.page_design = JSON.parse(item.page_design);
    return Response.json({ ok: true });
  }
  throw new Error('Unexpected request in test fixture');
};
