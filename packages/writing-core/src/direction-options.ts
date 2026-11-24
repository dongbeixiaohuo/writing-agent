export const DIRECTION_PICK_PROMPT = '你可以选一个编号，也可以直接说想写哪个方向。';

function directionKey(text: string): string {
  return text.normalize('NFKC').replace(/[“”‘’"'\s]/gu, '')
    .replace(/(?<!\d),|,(?!\d)/gu, '').replace(/[。.!?]+$/u, '');
}

function orderedBlocks(text: string) {
  return [...text.matchAll(/^[ \t]*1[.)、][ \t]+[^\n]+(?:\n(?:[ \t\r]*\n)*[ \t]*(?:[2-9]|[1-9]\d+)[.)、][ \t]+[^\n]+)*/gmu)]
    .map(block => {
      const items = [...block[0].matchAll(/^[ \t]*(\d+)[.)、][ \t]+([^\n]+)/gmu)];
      const keys = items.map((item, index) => Number(item[1]) === index + 1 ? directionKey(item[2]!) : '');
      return { index: block.index, end: block.index + block[0].length, keys };
    });
}

function sameOptions(view: readonly string[], expected: readonly string[]): boolean {
  return view.length === expected.length && view.every((key, index) => key !== '' && key === expected[index]);
}

export function showsDirectionOptions(reply: string, directions: readonly string[]): boolean {
  const keys = directions.map(directionKey);
  return orderedBlocks(reply).some(block => sameOptions(block.keys, keys));
}

/** Handle both new replies and saved replies with the generated list at the end. */
export function removeDuplicateDirectionOptions(reply: string): string {
  const text = reply.trimEnd();
  const footer = '\n\n' + DIRECTION_PICK_PROMPT;
  if (!text.endsWith(footer)) return reply;
  const body = text.slice(0, -footer.length).trimEnd();
  const blocks = orderedBlocks(body);
  const appended = blocks.pop();
  if (!appended || appended.end !== body.length || appended.keys.length < 3 || appended.keys.length > 5) return reply;
  const inline = blocks.find(block => sameOptions(block.keys, appended.keys));
  if (!inline) return reply;
  // Keep the list where the reply introduced it, using the wording stored for selection.
  return body.slice(0, inline.index) + body.slice(appended.index) +
    body.slice(inline.end, appended.index).trimEnd() + footer;
}
