// Map MCP arguments to the existing BOOTH item fields. page_design is a full
// replacement with BOOTH's native structure; callers choose modules and content.
export function itemUpdateFields(args) {
  if (args.page_design !== undefined && args.page_design_modules !== undefined) {
    throw new Error('page_designとpage_design_modulesはどちらか一方を指定してください。');
  }
  const fields = {};
  for (const name of ['name', 'description', 'page_design', 'state', 'category_id',
    'purchase_limit', 'preorder_enabled']) {
    if (args[name] !== undefined) fields[name] = args[name];
  }
  if (args.page_design_modules !== undefined) {
    fields.page_design = { modules: args.page_design_modules.map(module => ({ type: 'text', ...module })) };
  }
  if (args.tags !== undefined) fields.tags_array = args.tags;
  if (args.adult !== undefined) fields.adult = String(args.adult);
  if (Object.keys(fields).length === 0) throw new Error('更新するフィールドが1つも指定されていません。');
  return fields;
}
