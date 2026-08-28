import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPOUND_WORDS,
  camelCase,
  goExportedCase,
  pascalCase,
  singularize,
  snakeCase,
  splitCompound,
  tokenize,
} from './names.js';

const VOCAB = new Set(DEFAULT_COMPOUND_WORDS);

describe('tokenize', () => {
  it.each([
    ['_id', ['id']],
    ['userId', ['user', 'id']],
    ['user_id', ['user', 'id']],
    ['X-Content-Range', ['x', 'content', 'range']],
    ['AssetsResponse', ['assets', 'response']],
    ['HTTPResponse', ['http', 'response']],
    ['addUserGroupsToHistory', ['add', 'user', 'groups', 'to', 'history']],
    ['countByProject', ['count', 'by', 'project']],
    ['oauth2Token', ['oauth2', 'token']],
  ])('%s → %j', (input, expected) => {
    expect(tokenize(input)).toEqual(expected);
  });

  it('leaves names it does not understand alone', () => {
    // `ass` is the ASS subtitle format. Renaming what you do not understand is worse than
    // leaving it (SPEC.md §3.1.2).
    expect(tokenize('ass', VOCAB)).toEqual(['ass']);
    expect(tokenize('ffprobe', VOCAB)).toEqual(['ffprobe']);
  });
});

describe('splitCompound', () => {
  it('splits all-lowercase compounds using the vocabulary', () => {
    expect(splitCompound('assettypes', VOCAB)).toEqual(['asset', 'types']);
    expect(splitCompound('workrequests', VOCAB)).toEqual(['work', 'requests']);
    expect(splitCompound('mediainfo', VOCAB)).toEqual(['media', 'info']);
  });

  it('splits regardless of a leading capital, which is not a word boundary', () => {
    // The bug this pins: guarding on "all lowercase" skipped `Assettypes`, so the resource
    // class stayed `Assettypes` while the lowercase spelling split correctly.
    expect(tokenize('Assettypes', VOCAB)).toEqual(['asset', 'types']);
    expect(tokenize('Workrequests', VOCAB)).toEqual(['work', 'requests']);
  });

  it('never splits a word that is itself in the vocabulary', () => {
    for (const word of ['translations', 'notifications', 'territories', 'offlines', 'previews']) {
      expect(splitCompound(word, VOCAB), word).toEqual([word]);
    }
  });

  it('leaves short tokens alone', () => {
    expect(splitCompound('ass', VOCAB)).toEqual(['ass']);
    expect(splitCompound('tag', VOCAB)).toEqual(['tag']);
  });

  it('refuses to split when any segment is unknown', () => {
    // A wrong split produces a confidently misspelled public identifier, which is worse than
    // no split at all.
    expect(splitCompound('ffprobexyz', VOCAB)).toEqual(['ffprobexyz']);
    expect(splitCompound('zzzzzzuser', VOCAB)).toEqual(['zzzzzzuser']);
  });

  it('prefers the fewest segments', () => {
    expect(splitCompound('workrequests', VOCAB)).toHaveLength(2);
  });

  it('does not split when no vocabulary is supplied', () => {
    expect(tokenize('assettypes')).toEqual(['assettypes']);
  });
});

describe('singularize', () => {
  it.each([
    ['replies', 'reply'],
    ['files', 'file'],
    ['materials', 'material'],
    ['addresses', 'address'],
    ['categories', 'category'],
    ['boxes', 'box'],
  ])('%s → %s', (input, expected) => {
    expect(singularize(input)).toBe(expected);
  });

  it('leaves words that only look plural alone', () => {
    for (const word of ['status', 'aspera', 'media', 'ass']) {
      expect(singularize(word), word).toBe(word);
    }
  });

  it('does not strip `es` after a single s', () => {
    // The bug: `(ch|sh|x|z|s)es$` turned `phases` into `phas` and `houses` into `hous`.
    expect(singularize('phases')).toBe('phase');
    expect(singularize('houses')).toBe('house');
    // …while still handling genuine sibilant plurals.
    expect(singularize('classes')).toBe('class');
    expect(singularize('boxes')).toBe('box');
  });

  it('uses the vocabulary to settle cases regex cannot', () => {
    // `studios` (plural of studio) and `status` (singular) are indistinguishable by shape.
    expect(singularize('studios', VOCAB)).toBe('studio');
    expect(singularize('status', VOCAB)).toBe('status');
    expect(singularize('statuses', VOCAB)).toBe('status');
    expect(singularize('series', VOCAB)).toBe('series');
  });

  it('leaves mass nouns and invariant plurals alone', () => {
    // `graphics` names a thing; `GraphicComment` is not what the API means.
    for (const word of ['graphics', 'news', 'series', 'species', 'lens', 'headquarters']) {
      expect(singularize(word), word).toBe(word);
    }
  });

  it('strips the whole `es` when the stem itself ends in s', () => {
    // Stripping a bare `s` gave `aliase`.
    expect(singularize('aliases')).toBe('alias');
    expect(singularize('buses')).toBe('bus');
    expect(singularize('statuses')).toBe('status');
    expect(singularize('processes')).toBe('process');
  });

  it('without a vocabulary, protects only reliably-singular endings', () => {
    // An earlier `os$` guard here wrongly protected `studios`.
    expect(singularize('studios')).toBe('studio');
    expect(singularize('analysis')).toBe('analysis');
    expect(singularize('address')).toBe('address');
  });
});

describe('casing', () => {
  const tokens = ['user', 'id'];

  it('produces the convention each language actually uses', () => {
    expect(camelCase(tokens)).toBe('userId');
    expect(pascalCase(tokens)).toBe('UserId');
    expect(snakeCase(tokens)).toBe('user_id');
    // Go uppercases recognized initialisms; TypeScript does not.
    expect(goExportedCase(tokens)).toBe('UserID');
  });

  it('does not uppercase initialisms in TypeScript casing', () => {
    // `apiURL` is not idiomatic TypeScript even though it is idiomatic Go.
    expect(camelCase(['api', 'url'])).toBe('apiUrl');
  });
});
