/**
 * Thin compatibility layer over js-yaml 5 (AISDLC-866).
 *
 * js-yaml 5 dropped the default export and made `load` throw
 * `YAMLException: expected a document, but the input is empty` for empty or
 * comment-only input (4.x returned `undefined`). Every caller in this package
 * relied on the 4.x contract (an empty config file means "use defaults"), so
 * `load` here restores it while leaving real parse errors untouched.
 */
import * as jsYaml from 'js-yaml';

export type { LoadOptions } from 'js-yaml';
export { CORE_SCHEMA, dump, JSON_SCHEMA, YAMLException } from 'js-yaml';

const EMPTY_DOCUMENT = 'expected a document, but the input is empty';

/** Parse a YAML string; empty / comment-only input yields `undefined` (js-yaml 4 behaviour). */
export function load(input: string, options?: jsYaml.LoadOptions): unknown {
  try {
    return jsYaml.load(input, options);
  } catch (err) {
    if (err instanceof jsYaml.YAMLException && err.reason === EMPTY_DOCUMENT) {
      return undefined;
    }
    throw err;
  }
}
