import { describe, expect, it } from 'vitest';
import { noteBasename, splitWikilinks, wikilinkLabel } from './wikilinks';

describe('wikilinks', () => {
  it('splits text, links, aliases, headings and embeds', () => {
    const s = splitWikilinks(
      'See [[Fuse box]] and ![[Dishwasher/manual.pdf|Manual]] or [[Oven#Quick help]].',
    );
    expect(s.map((x) => (x.kind === 'text' ? x.text : wikilinkLabel(x.link)))).toEqual([
      'See ',
      'Fuse box',
      ' and ',
      'Manual',
      ' or ',
      'Oven › Quick help',
      '.',
    ]);
    const embed = s[3];
    expect(embed?.kind === 'link' && embed.link).toMatchObject({
      target: 'Dishwasher/manual.pdf',
      embed: true,
    });
  });

  it('labels heading and block links like Obsidian', () => {
    const label = (t: string) => {
      const s = splitWikilinks(t)[0]!;
      return s.kind === 'link' ? wikilinkLabel(s.link) : s.text;
    };
    expect(label('[[Dishwasher#Quick help]]')).toBe('Dishwasher › Quick help');
    expect(label('[[Dishwasher#Notes#Salt]]')).toBe('Dishwasher › Notes › Salt');
    expect(label('[[Dishwasher#^abc123]]')).toBe('Dishwasher');
    expect(label('[[#Maintenance log]]')).toBe('Maintenance log');
  });

  it('leaves text without links alone', () => {
    expect(splitWikilinks('no [links] here')).toEqual([{ kind: 'text', text: 'no [links] here' }]);
  });

  it('derives note basenames', () => {
    expect(noteBasename('House/Kitchen/Dishwasher.md')).toBe('Dishwasher');
  });
});
